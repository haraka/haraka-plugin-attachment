// attachment

// node.js builtins
var fs     = require('fs');
var exec   = require('child_process').exec;
var path   = require('path');
var crypto = require('crypto');

// npm dependencies
var tmp    = require('tmp');
var constants = require('haraka-constants');

var archives_disabled = false;

exports.register = function () {

    tmp.setGracefulCleanup();

    this.load_attachment_ini();

    this.load_n_compile_re('file',    'attachment.filename.regex');
    this.load_n_compile_re('ctype',   'attachment.ctype.regex');
    this.load_n_compile_re('archive', 'attachment.archive.filename.regex');

    this.register_hook('data',        'init_attachment');
    this.register_hook('data_post',   'wait_for_attachment_hooks');
    this.register_hook('data_post',   'check_attachments');
};

exports.load_attachment_ini = function () {
    var plugin = this;

    plugin.cfg = plugin.config.get('attachment.ini', function () {
        plugin.load_attachment_ini();
    });

    plugin.cfg.timeout = (plugin.cfg.main.timeout || 30) * 1000;

    // repair a mismatch between legacy docs and code
    var extns = (plugin.cfg.archive && plugin.cfg.archive.extensions) ?
                plugin.cfg.archive.extensions :      // new
                plugin.cfg.main.archive_extensions ? // old code
                plugin.cfg.main.archive_extensions :
                plugin.cfg.main.archive_extns ?      // old docs
                plugin.cfg.main.archive_extns :
                '';

    var maxd = (plugin.cfg.archive && plugin.cfg.archive.max_depth) ?
                plugin.cfg.main.archive.max_depth :   // new
                plugin.cfg.main.archive_max_depth ?   // old
                plugin.cfg.main.archive_max_depth :
                5;                                    // default

    plugin.cfg.archive = {
        max_depth: maxd,
        exts : plugin.options_to_object(extns) ||
               plugin.options_to_object('zip tar tgz taz z gz rar 7z'),
    };

    plugin.load_dissallowed_extns();
};

exports.load_dissallowed_extns = function () {
    var plugin = this;

    if (!plugin.cfg.main.disallowed_extensions) return;

    if (!plugin.re) plugin.re = {};
    plugin.re.bad_extn = new RegExp(
            '\\.(?:' +
                (plugin.cfg.main.disallowed_extensions
                .replace(/\s+/,' ')
                .split(/[;, ]/)
                .join('|')) +
            ')$', 'i');
};

exports.load_n_compile_re = function (name, file) {
    var plugin = this;
    var valid_re = [];

    var try_re = plugin.config.get(file, 'list', function () {
        plugin.load_n_compile_re(name, file);
    });

    for (var r=0; r < try_re.length; r++) {
        try {
            var reg = new RegExp(try_re[r], 'i');
        }
        catch (e) {
            this.logerror('skipping invalid regexp: /' + try_re[r] +
                    '/ (' + e + ')');
            return;
        }
        valid_re.push(reg);
    }

    if (!plugin.re) plugin.re = {};
    plugin.re[name] = valid_re;
};

exports.options_to_object = function (options) {
    if (!options) return false;

    var res = {};
    options.toLowerCase().replace(/\s+/,' ').split(/[;, ]/)
        .forEach(function (opt) {
            if (!opt) return;
            if (opt[0] !== '.') opt = '.' + opt;
            res[opt.trim()]=true;
        });

    if (Object.keys(res).length) return res;
    return false;
};

exports.unarchive_recursive = function (connection, f, archive_file_name, cb) {
    var plugin = this;

    if (archives_disabled) {
        connection.logdebug(this, 'archive support disabled');
        return cb();
    }

    var files = [];
    var tmpfiles = [];
    var depth_exceeded = false;
    var count = 0;
    var done_cb = false;
    var timer;

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
                connection.logdebug(plugin, 'closed fd: ' + t[0]);
                fs.unlink(t[1], function () {
                    connection.logdebug(plugin, 'deleted tempfile: ' + t[1]);
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
        var cmd = 'LANG=C bsdtar -tf ' + in_file;
        exec(cmd, { timeout: plugin.cfg.timeout },  function (err, stdout, stderr) {
            count--;
            if (err) {
                if (err.code === 127) {
                    // file not found
                    plugin.logwarn('bsdtar not found, disabling archive features');
                    archives_disabled = true;
                    return do_cb();
                }
                if (err.code === null) {
                    // likely a timeout
                    return do_cb(new Error('timeout unpacking attachments'));
                }
                return do_cb(err);
            }
            var g = stdout.split(/\r?\n/);
            for (var i=0; i<g.length; i++) {
                var file = g[i];
                // Skip any blank lines
                if (!file) continue;
                connection.logdebug(plugin, 'file: ' + file + ' depth=' + depth);
                files.push((prefix ? prefix + '/' : '') + file);
                var extn = path.extname(file.toLowerCase());
                if (plugin.cfg.archive.exts[extn] ||
                    plugin.cfg.archive.exts[extn.substring(1)])
                {
                    connection.logdebug(plugin, 'need to extract file: ' + file);
                    count++;
                    depth++;
                    (function (file2, depth2) {
                        tmp.file(function (err2, tmpfile, fd) {
                            count--;
                            if (err2) return do_cb(err2.message);
                            connection.logdebug(plugin, 'created tmp file: ' + tmpfile + '(fd=' + fd + ') for file ' + (prefix ? prefix + '/' : '') + file);
                            // Extract this file from the archive
                            var cmd2 = 'LANG=C bsdtar -Oxf ' + in_file + ' --include="' + file2 + '" > ' + tmpfile;
                            tmpfiles.push([fd, tmpfile]);
                            connection.logdebug(plugin, 'running command: ' + cmd2);
                            count++;
                            exec(cmd2, { timeout: plugin.cfg.timeout }, function (err3, stdout2, stderr3) {
                                count--;
                                if (err3) {
                                    connection.logdebug(plugin, 'error: return code ' + err3.code + ': ' + stderr.toString('utf-8'));
                                    return do_cb(new Error(stderr.toString('utf-8').replace(/\r?\n/g,' ')));
                                }
                                else {
                                    // Recurse
                                    return listFiles(tmpfile, (prefix ? prefix + '/' : '') + file2, depth2);
                                }
                            });
                        });
                    })(file, depth);
                }
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
};

function attachments_still_processing (txn) {
    if (txn.notes.attachment.todo_count > 0) return true;
    if (!txn.notes.attachment.next) return true;
    return false;
}

exports.compute_and_log_md5sum = function (connection, ctype, filename, stream) {
    var plugin = this;
    var md5 = crypto.createHash('md5');
    var digest;
    var bytes = 0;
    stream.on('data', function (data) {
        bytes += data.length;
        md5.update(data);
    });
    stream.once('end', function () {
        digest = md5.digest('hex');
        var ca = ctype.match(/^(.*)?;\s+name="(.*)?"/);
        connection.transaction.results.push(plugin, { attach: {
            file: filename,
            ctype: (ca && ca[2] === filename) ? ca[1] : ctype,
            md5: digest,
            bytes: bytes,
        },
        });
        connection.loginfo(plugin, 'file="' + filename + '" ctype="' +
                ctype + '" md5=' + digest);
    });
}

exports.file_extension = function (filename) {
    if (!filename) return '';

    var ext_match = filename.match(/(\.[^\. ]+)$/);
    if (!ext_match) return '';
    if (!ext_match[1]) return '';

    return ext_match[1].toLowerCase();
};

exports.content_type = function (connection, ctype) {
    var plugin = this;

    var ct_match = ctype.match(/^([^\/]+\/[^;\r\n ]+)/);
    if (!ct_match) return '';
    if (!ct_match[1]) return '';

    connection.logdebug(plugin, 'found content type: ' + ct_match[1]);
    connection.transaction.notes.attachment.ctypes.push(ct_match[1]);
    return ct_match[1];
};

exports.has_archive_extension = function (file_ext) {
    var plugin = this;
    // check with and without the dot prefixed
    if (plugin.cfg.archive.exts[file_ext]) return true;
    if (plugin.cfg.archive.exts[file_ext.substring(1)]) return true;
    return false;
};

exports.start_attachment = function (connection, ctype, filename, body, stream) {
    var plugin = this;
    var txn = connection.transaction;

    function next () {
        if (attachments_still_processing(txn)) return;
        txn.notes.attachment.next();
    }

    plugin.compute_and_log_md5sum(connection, ctype, filename, stream);

    var content_type = plugin.content_type(connection, ctype);
    var file_ext     = plugin.file_extension(filename);

    function add_to_attachments () {
        txn.notes.attachments.push({
            ctype: content_type || 'unknown/unknown',
            filename: (filename ? filename : ''),
            extension: file_ext,
        });
    }

    add_to_attachments();
    if (!filename) return;

    connection.logdebug(plugin, 'found attachment file: ' + filename);
    txn.notes.attachment.files.push(filename);

    if (archives_disabled) return;

    if (!plugin.has_archive_extension(file_ext)) return;

    connection.logdebug(plugin, 'found ' + file_ext + ' on archive list');
    txn.notes.attachment.todo_count++;

    stream.connection = connection;
    stream.pause();

    tmp.file(function (err, fn, fd) {
        function cleanup () {
            fs.close(fd, function () {
                connection.logdebug(plugin, 'closed fd: ' + fd);
                fs.unlink(fn, function () {
                    connection.logdebug(plugin, 'unlinked: ' + fn);
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
            save_archive_error(err.message, 'Error writing tempfile: ' + err.message);
            stream.resume();
            return;
        }
        connection.logdebug(plugin, 'Got tmpfile: attachment="' + filename + '" tmpfile="' + fn + '" fd=' + fd);
        var ws = fs.createWriteStream(fn);
        stream.pipe(ws);
        stream.resume();
        ws.on('error', function (error) {
            save_archive_error(error.message, 'stream error: ' + error.message);
        });
        ws.on('close', function () {
            connection.logdebug(plugin, 'end of stream');
            plugin.expand_tmpfile(connection, fn, filename, cleanup, next);
        });
    });
};

exports.expand_tmpfile = function (connection, fn, filename, cleanup, done) {
    var plugin = this;
    var txn = connection.transaction;
    plugin.unarchive_recursive(connection, fn, filename, function (err, files) {
        txn.notes.attachment.todo_count--;
        cleanup();
        if (err) {
            connection.logerror(plugin, err.message);
            if (err.message === 'maximum archive depth exceeded') {
                txn.notes.attachment.result = [ constants.DENY, 'Message contains nested archives exceeding the maximum depth' ];
            }
            else if (/Encrypted file is unsupported/i.test(err.message)) {
                txn.notes.attachment.result = [ constants.DENY, 'Message contains encrypted archive' ];
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
};

exports.init_attachment = function (next, connection) {
    var plugin = this;
    var txn = connection.transaction;
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
    return next();
};

exports.disallowed_extensions = function (txn) {
    var plugin = this;
    if (!plugin.re.bad_extn) return false;

    var bad = false;
    [ txn.notes.attachment.files, txn.notes.attachment.archive_files ]
    .forEach(function (items) {
        if (bad) return;
        if (!items || !Array.isArray(items)) return;
        for (var i=0; i < items.length; i++) {
            if (!plugin.re.bad_extn.test(items[i])) continue;
            bad = items[i].split('.').slice(0).pop();
            break;
        }
    });

    return bad;
};

exports.check_attachments = function (next, connection) {
    var plugin = this;
    var txn = connection.transaction;

    // Check for any stored errors from the attachment hooks
    if (txn.notes.attachment.result) {
        var result = txn.notes.attachment.result;
        return next(result[0], result[1]);
    }

    var ctypes = txn.notes.attachment.ctypes;

    // Add in any content type from message body
    var ct_re = /^([^\/]+\/[^;\r\n ]+)/;
    var body = txn.body;
    if (body) {
        var body_ct = ct_re.exec(body.header.get('content-type'));
        if (body_ct) {
            connection.logdebug(this, 'found content type: ' + body_ct[1]);
            ctypes.push(body_ct[1]);
        }
    }
    // MIME parts
    if (body && body.children) {
        for (var c=0; c<body.children.length; c++) {
            if (!body.children[c]) continue;
            var child_ct = ct_re.exec(
                    body.children[c].header.get('content-type'));
            if (!child_ct) continue;
            connection.logdebug(this, 'found content type: ' + child_ct[1]);
            ctypes.push(child_ct[1]);
        }
    }

    var bad_extn = this.disallowed_extensions(txn);
    if (bad_extn) {
        return next(constants.DENY, 'Message contains disallowed file extension (' +
                    bad_extn + ')');
    }

    var ctypes_result = this.check_items_against_regexps(ctypes, plugin.re.ctype);
    if (ctypes_result) {
        connection.loginfo(this, 'match ctype="' + ctypes_result[0] + '" regexp=/' + ctypes_result[1] + '/');
        return next(constants.DENY, 'Message contains unacceptable content type (' + ctypes_result[0] + ')');
    }

    var files = txn.notes.attachment.files;
    var files_result = this.check_items_against_regexps(files, plugin.re.file);
    if (files_result) {
        connection.loginfo(this, 'match file="' + files_result[0] + '" regexp=/' + files_result[1] + '/');
        return next(constants.DENY, 'Message contains unacceptable attachment (' + files_result[0] + ')');
    }

    var archive_files = txn.notes.attachment.archive_files;
    var archives_result = this.check_items_against_regexps(archive_files, plugin.re.archive);
    if (archives_result) {
        connection.loginfo(this, 'match file="' + archives_result[0] + '" regexp=/' + archives_result[1] + '/');
        return next(constants.DENY, 'Message contains unacceptable attachment (' + archives_result[0] + ')');
    }

    return next();
};

exports.check_items_against_regexps = function (items, regexps) {
    if (!regexps || !items) return false;
    if (!Array.isArray(regexps) || !Array.isArray(items)) return false;
    if (!regexps.length || !items.length) return false;

    for (var r=0; r < regexps.length; r++) {
        for (var i=0; i < items.length; i++) {
            if (regexps[r].test(items[i])) {
                return [ items[i], regexps[r] ];
            }
        }
    }
    return false;
};

exports.wait_for_attachment_hooks = function (next, connection) {
    var txn = connection.transaction;
    if (txn.notes.attachment.todo_count > 0) {
        // We still have attachment hooks running
        txn.notes.attachment.next = next;
    }
    else {
        next();
    }
};
