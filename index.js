'use strict';

// node.js builtins
const fs     = require('fs');
const { spawn } = require('child_process');
const path   = require('path');
const crypto = require('crypto');

// npm dependencies
const constants = require('haraka-constants');

let tmp;
let archives_disabled = false;

exports.register = function () {

    this.load_tmp_module();
    this.load_attachment_ini();

    this.load_n_compile_re('file',    'attachment.filename.regex');
    this.load_n_compile_re('ctype',   'attachment.ctype.regex');
    this.load_n_compile_re('archive', 'attachment.archive.filename.regex');

    this.register_hook('data',        'init_attachment');
    this.register_hook('data_post',   'wait_for_attachment_hooks');
    this.register_hook('data_post',   'check_attachments');
}

exports.load_tmp_module = function () {
    try {
        tmp = require('tmp');
        tmp.setGracefulCleanup();
    }
    catch (e) {
        archives_disabled = true;
        this.logwarn(`the 'tmp' module is required to extract filenames from archives`);
    }
}

exports.load_attachment_ini = function () {
    const plugin = this;

    plugin.cfg = plugin.config.get('attachment.ini', () => {
        plugin.load_attachment_ini();
    });

    plugin.cfg.timeout = (plugin.cfg.main.timeout || 30) * 1000;

    // repair a mismatch between legacy docs and code
    const extns = (plugin.cfg.archive && plugin.cfg.archive.extensions) ?
        plugin.cfg.archive.extensions :          // new
        plugin.cfg.main.archive_extensions ?     // old code
            plugin.cfg.main.archive_extensions :
            plugin.cfg.main.archive_extns ?      // old docs
                plugin.cfg.main.archive_extns :
                '';

    const maxd = (plugin.cfg.archive && plugin.cfg.archive.max_depth) ?
        plugin.cfg.archive.max_depth :           // new
        plugin.cfg.main.archive_max_depth ?      // old
            plugin.cfg.main.archive_max_depth :
            5;                                   // default

    plugin.cfg.archive = {
        max_depth: maxd,
        exts : plugin.options_to_object(extns) ||
               plugin.options_to_object('zip tar tgz taz z gz rar 7z'),
    };

    plugin.load_dissallowed_extns();
}

exports.find_bsdtar_path = function (cb) {
    let found = false;
    let i = 0;
    ['/bin', '/usr/bin', '/usr/local/bin'].forEach((dir) => {
        if (found) return;
        i++;
        fs.stat(`${dir}/bsdtar`, (err, stats) => {
            i--;
            if (found) return;
            if (err) {
                if (i===0) cb(new Error('bsdtar not found'));
                return;
            }
            found = true;
            cb(null, dir);
        });
        if (i===0) cb(new Error('bsdtar not found'));
    });
}

exports.hook_init_master = exports.hook_init_child = function (next) {
    const plugin = this;
    plugin.find_bsdtar_path((err, dir) => {
        if (err) {
            archives_disabled = true;
            plugin.logwarn(`This plugin requires the 'bsdtar' binary to extract filenames from archive files`);
        }
        else {
            plugin.logdebug(`found bsdtar in ${dir}`);
            plugin.bsdtar_path = `${dir}/bsdtar`;
        }
        next();
    });
}

exports.load_dissallowed_extns = function () {
    const plugin = this;

    if (!plugin.cfg.main.disallowed_extensions) return;

    if (!plugin.re) plugin.re = {};
    plugin.re.bad_extn = new RegExp(
        '\\.(?:' +
                (plugin.cfg.main.disallowed_extensions
                    .replace(/\s+/,' ')
                    .split(/[;, ]/)
                    .join('|')) +
            ')$', 'i');
}

exports.load_n_compile_re = function (name, file) {
    const plugin = this;
    const valid_re = [];

    const try_re = plugin.config.get(file, 'list', function () {
        plugin.load_n_compile_re(name, file);
    });

    for (let r=0; r < try_re.length; r++) {
        try {
            const reg = new RegExp(try_re[r], 'i');
            valid_re.push(reg);
        }
        catch (e) {
            this.logerror(`skipping invalid regexp: /${try_re[r]}/ (${e})`);
        }
    }

    if (!plugin.re) plugin.re = {};
    plugin.re[name] = valid_re;
}

exports.options_to_object = function (options) {
    if (!options) return false;

    const res = {};
    options.toLowerCase().replace(/\s+/,' ').split(/[;, ]/).forEach((opt) => {
        if (!opt) return;
        res[opt.trim()]=true;
    })

    if (Object.keys(res).length) return res;
    return false;
}

exports.unarchive_recursive = function (connection, f, archive_file_name, cb) {
    const plugin = this;

    if (archives_disabled) {
        connection.logdebug(this, 'archive support disabled');
        return cb();
    }

    const files = [];
    const tmpfiles = [];
    const depth_exceeded = false;
    let count = 0;
    let done_cb = false;
    let timer;

    function do_cb (err, files2) {
        if (timer) clearTimeout(timer);
        if (done_cb) return;

        done_cb = true;
        deleteTempFiles();
        return cb(err, files2);
    }

    function deleteTempFiles () {
        tmpfiles.forEach(function (t) {
            fs.close(t[0], function () {
                connection.logdebug(plugin, `closed fd: ${t[0]}`);
                fs.unlink(t[1], function () {
                    connection.logdebug(plugin, `deleted tempfile: ${t[1]}`);
                });
            });
        });
    }

    function listFiles (in_file, prefix, depth) {
        if (!depth) depth = 0;
        if (depth >= plugin.cfg.archive.max_depth || depth_exceeded) {
            if (count === 0) {
                return do_cb(new Error('maximum archive depth exceeded'));
            }
            return;
        }
        count++;
        const bsdtar = spawn(plugin.bsdtar_path, [ '-tf', in_file ], {
            'cwd': '/tmp',
            'env': { 'LANG': 'C' },
        });

        // Start timer
        let t1_timeout = false;
        const t1_timer = setTimeout(() => {
            t1_timeout = true;
            bsdtar.kill();
            return do_cb(new Error('bsdtar timed out'));
        }, plugin.cfg.timeout);

        let lines = "";
        bsdtar.stdout.on('data', (data) => { lines += data; });

        let stderr = "";
        bsdtar.stderr.on('data', (data) => { stderr += data; });

        bsdtar.on('exit', (code, signal) => {
            count--;
            if (t1_timeout) return;
            clearTimeout(t1_timer);

            if (code && code > 0) {
                // Error was returned
                return do_cb(new Error(`bsdtar returned error code: ${code} error=${stderr.replace(/\r?\n/,' ')}`));
            }
            if (signal) {
                // Process terminated due to signal
                return do_cb(new Error(`bsdtar terminated by signal: ${signal}`));
            }

            // Process filenames
            const fl = lines.split(/\r?\n/);
            for (let i=0; i<fl.length; i++) {
                const file = fl[i];
                // Skip any blank lines
                if (!file) continue;

                connection.logdebug(plugin, `file: ${file} depth=${depth}`);
                files.push((prefix ? `${prefix}/` : '') + file);

                const extn = path.extname(file.toLowerCase());
                if (!plugin.cfg.archive.exts[extn] && !plugin.cfg.archive.exts[extn.substring(1)]) {
                    continue;
                }

                connection.logdebug(plugin, 'need to extract file: ' + file);
                count++;
                depth++;
                (function (file2, depth2) {
                    tmp.file(function (err2, tmpfile, fd) {
                        count--;
                        if (err2) return do_cb(err2.message);
                        connection.logdebug(plugin, `created tmp file: ${tmpfile} (fd=${fd}) for file ${(prefix ? prefix + '/' : '')} ${file2}`);
                        // Extract this file from the archive
                        const cmd2 = 'LANG=C bsdtar -Oxf ' + in_file + ' --include="' + file2 + '" > ' + tmpfile;
                        tmpfiles.push([fd, tmpfile]);
                        connection.logdebug(plugin, 'running command: ' + cmd2);
                        count++;

                        const cmd = spawn(plugin.bsdtar_path,
                            [ '-Oxf', in_file, '--include=' + file2 ],
                            {
                                'cwd': '/tmp',
                                'env': {
                                    'LANG': 'C'
                                },
                            }
                        );
                        // Start timer
                        let t2_timeout = false;
                        const t2_timer = setTimeout(() => {
                            t2_timeout = true;
                            return do_cb(new Error(`bsdtar timed out extracting file ${file2}`));
                        }, plugin.cfg.timeout);

                        // Create WriteStream for this file
                        const tws = fs.createWriteStream(tmpfile, { 'fd': fd });
                        let stderr2 = '';

                        cmd.stderr.on('data', (data) => { stderr2 += data; });

                        cmd.on('exit', (code2, signal2) => {
                            count--;
                            if (t2_timeout) return;
                            clearTimeout(t2_timer);
                            if (code2 && code2 > 0) {
                                // Error was returned
                                return do_cb(new Error(`bsdtar returned error code: ${code2} error=${stderr2.replace(/\r?\n/,' ')}`));
                            }
                            if (signal) {
                                // Process terminated due to signal
                                return do_cb(new Error(`bsdtar terminated by signal: ${signal}`));
                            }
                            // Recurse
                            return listFiles(tmpfile, (prefix ? prefix + '/' : '') + file2, depth);
                        });
                        cmd.stdout.pipe(tws);
                    });
                })(file, depth);
            }
            if (depth > 0) depth--;
            connection.logdebug(plugin, 'finish: count=' + count + ' depth=' + depth);
            if (count === 0) {
                return do_cb(null, files);
            }
        });
    }

    timer = setTimeout(function () {
        return do_cb(new Error('timeout unpacking attachments'));
    }, plugin.cfg.timeout);

    listFiles(f, archive_file_name);
}

function attachments_still_processing (txn) {
    if (txn.notes.attachment.todo_count > 0) return true;
    if (!txn.notes.attachment.next) return true;
    return false;
}

exports.compute_and_log_md5sum = function (connection, ctype, filename, stream) {
    const plugin = this;
    const md5 = crypto.createHash('md5');
    let digest;
    let bytes = 0;

    stream.on('data', (data) => {
        md5.update(data);
        bytes += data.length;
    })

    stream.once('end', () => {
        digest = md5.digest('hex');
        const ca = ctype.match(/^(.*)?;\s+name="(.*)?"/);
        connection.transaction.results.push(plugin, { attach:
            {
                file: filename,
                ctype: (ca && ca[2] === filename) ? ca[1] : ctype,
                md5: digest,
                bytes: bytes,
            },
        });
        connection.loginfo(plugin, `file="${filename}" ctype="${ctype}" md5=${digest} bytes=${bytes}`);
    })
}

exports.file_extension = function (filename) {
    if (!filename) return '';

    const ext_match = filename.match(/\.([^. ]+)$/);
    if (!ext_match) return '';
    if (!ext_match[1]) return '';

    return ext_match[1].toLowerCase();
}

exports.content_type = function (connection, ctype) {
    const plugin = this;

    const ct_match = ctype.match(/^([^/]+\/[^;\r\n ]+)/);
    if (!ct_match) return '';
    if (!ct_match[1]) return '';

    connection.logdebug(plugin, 'found content type: ' + ct_match[1]);
    connection.transaction.notes.attachment.ctypes.push(ct_match[1]);
    return ct_match[1];
}

exports.has_archive_extension = function (file_ext) {
    const plugin = this;
    // check with and without the dot prefixed
    if (plugin.cfg.archive.exts[file_ext]) return true;
    if (file_ext[0] === '.' && plugin.cfg.archive.exts[file_ext.substring(1)]) return true;
    return false;
}

exports.start_attachment = function (connection, ctype, filename, body, stream) {
    const plugin = this;
    const txn = connection.transaction;

    function next () {
        if (attachments_still_processing(txn)) return;
        txn.notes.attachment.next();
    }

    plugin.compute_and_log_md5sum(connection, ctype, filename, stream);

    const content_type = plugin.content_type(connection, ctype);
    const file_ext     = plugin.file_extension(filename);

    txn.notes.attachments.push({
        ctype: content_type || 'unknown/unknown',
        filename: (filename ? filename : ''),
        extension: `.${file_ext}`,
    });

    if (!filename) return;

    connection.logdebug(plugin, `found attachment file: ${filename}`);
    txn.notes.attachment.files.push(filename);

    // Start archive processing
    if (archives_disabled) return;
    if (!plugin.has_archive_extension(file_ext)) return;

    connection.logdebug(plugin, `found ${file_ext} on archive list`);
    txn.notes.attachment.todo_count++;

    stream.connection = connection;
    stream.pause();

    tmp.file((err, fn, fd) => {
        function cleanup () {
            fs.close(fd, function () {
                connection.logdebug(plugin, `closed fd: ${fd}`);
                fs.unlink(fn, function () {
                    connection.logdebug(plugin, `unlinked: ${fn}`);
                });
            });
        }
        function save_archive_error (deny_msg, log_msg) {
            txn.notes.attachment.result = [ constants.DENYSOFT, deny_msg ];
            txn.notes.attachment.todo_count--;
            connection.logerror(plugin, log_msg);
            cleanup();
            next();
        }
        if (err) {
            save_archive_error(err.message, `Error writing tempfile: ${err.message}`);
            stream.resume();
            return;
        }
        connection.logdebug(plugin, `Got tmpfile: attachment="${filename}" tmpfile="${fn}" fd={fd}`);

        const ws = fs.createWriteStream(fn);
        stream.pipe(ws);
        stream.resume();

        ws.on('error', function (error) {
            save_archive_error(error.message, `stream error: ${error.message}`);
        });

        ws.on('close', function () {
            connection.logdebug(plugin, 'end of stream reached');
            connection.pause();
            plugin.expand_tmpfile(connection, fn, filename, cleanup, next);
        });
    });
}

exports.expand_tmpfile = function (connection, fn, filename, cleanup, done) {
    const plugin = this;
    const txn = connection.transaction;

    plugin.unarchive_recursive(connection, fn, filename, function (err, files) {
        txn.notes.attachment.todo_count--;
        cleanup();
        if (err) {
            connection.logerror(plugin, err.message);
            if (err.message === 'maximum archive depth exceeded') {
                txn.notes.attachment.result = [ constants.DENY, 'Message contains nested archives exceeding the maximum depth' ];
            }
            else if (/Encrypted file is unsupported/i.test(err.message)) {
                if (!plugin.cfg.archive.allow_encrypted) {
                    txn.notes.attachment.result = [ constants.DENY, 'Message contains encrypted archive' ];
                }
            }
            else {
                txn.notes.attachment.result = [ constants.DENYSOFT, 'Error unpacking archive' ];
            }
        }
        else {
            txn.notes.attachment.archive_files = txn.notes.attachment.archive_files.concat(files);
        }
        return done();
    });
}

exports.init_attachment = function (next, connection) {
    const plugin = this;
    const txn = connection.transaction;
    txn.parse_body = 1;

    txn.notes.attachment = {
        todo_count: 0,
        ctypes: [],
        files: [],
        archive_files: [],
    }
    txn.notes.attachments = [];

    txn.notes.attachment.files = [];
    txn.notes.attachment.archive_files = [];

    txn.attachment_hooks(function (ctype, filename, body, stream) {
        plugin.start_attachment(connection, ctype, filename, body, stream);
    });
    next();
}

exports.disallowed_extensions = function (txn) {
    const plugin = this;
    if (!plugin.re.bad_extn) return false;

    let bad = false;
    [ txn.notes.attachment.files, txn.notes.attachment.archive_files ]
        .forEach(function (items) {
            if (bad) return;
            if (!items || !Array.isArray(items)) return;
            for (let i=0; i < items.length; i++) {
                if (!plugin.re.bad_extn.test(items[i])) continue;
                bad = items[i].split('.').slice(0).pop();
                break;
            }
        });

    return bad;
}

exports.check_attachments = function (next, connection) {
    const plugin = this;
    const txn = connection.transaction;

    // Check for any stored errors from the attachment hooks
    if (txn.notes.attachment.result) {
        const result = txn.notes.attachment.result;
        return next(result[0], result[1]);
    }

    const ctypes = txn.notes.attachment.ctypes;

    // Add in any content type from message body
    const ct_re = /^([^/]+\/[^;\r\n ]+)/;
    const body = txn.body;
    if (body) {
        const body_ct = ct_re.exec(body.header.get('content-type'));
        if (body_ct) {
            connection.logdebug(this, 'found content type: ' + body_ct[1]);
            ctypes.push(body_ct[1]);
        }
    }
    // MIME parts
    if (body && body.children) {
        for (let c=0; c<body.children.length; c++) {
            if (!body.children[c]) continue;
            const child_ct = ct_re.exec(
                body.children[c].header.get('content-type'));
            if (!child_ct) continue;
            connection.logdebug(this, 'found content type: ' + child_ct[1]);
            ctypes.push(child_ct[1]);
        }
    }

    const bad_extn = this.disallowed_extensions(txn);
    if (bad_extn) {
        return next(constants.DENY, `Message contains disallowed file extension (${bad_extn})`);
    }

    const ctypes_result = this.check_items_against_regexps(ctypes, plugin.re.ctype);
    if (ctypes_result) {
        connection.loginfo(this, `match ctype="${ctypes_result[0]}" regexp=/${ctypes_result[1]}/`);
        return next(constants.DENY, `Message contains unacceptable content type (${ctypes_result[0]})`);
    }

    const files = txn.notes.attachment.files;
    const files_result = this.check_items_against_regexps(files, plugin.re.file);
    if (files_result) {
        connection.loginfo(this, `match file="${files_result[0]}" regexp=/${files_result[1]}/`);
        return next(constants.DENY, 'Message contains unacceptable attachment (' + files_result[0] + ')');
    }

    const archive_files = txn.notes.attachment.archive_files;
    const archives_result = this.check_items_against_regexps(archive_files, plugin.re.archive);
    if (archives_result) {
        connection.loginfo(this, `match file="${archives_result[0]}" regexp=/${archives_result[1]}/`);
        return next(constants.DENY, 'Message contains unacceptable attachment (' + archives_result[0] + ')');
    }

    next();
}

exports.check_items_against_regexps = function (items, regexps) {
    if (!regexps || !items) return false;
    if (!Array.isArray(regexps) || !Array.isArray(items)) return false;
    if (!regexps.length || !items.length) return false;

    for (let r=0; r < regexps.length; r++) {
        for (let i=0; i < items.length; i++) {
            if (regexps[r].test(items[i])) {
                return [ items[i], regexps[r] ];
            }
        }
    }
    return false;
}

exports.wait_for_attachment_hooks = function (next, connection) {
    if (connection.transaction.notes.attachment.todo_count > 0) {
        // We still have attachment hooks running
        connection.transaction.notes.attachment.next = next;
    }
    else {
        next();
    }
}
