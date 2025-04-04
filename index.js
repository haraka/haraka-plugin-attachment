'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

let tmp;
let archives_disabled = false;

exports.re = {
  ct: /^([^/]+\/[^;\r\n ]+)/, // content type
};

exports.register = function () {
  this.load_tmp_module();
  this.load_attachment_ini();

  this.load_n_compile_re('file', 'attachment.filename.regex');
  this.load_n_compile_re('ctype', 'attachment.ctype.regex');
  this.load_n_compile_re('archive', 'attachment.archive.filename.regex');

  this.register_hook('data_post', 'wait_for_attachment_hooks');
  this.register_hook('data_post', 'check_attachments');
};

exports.load_tmp_module = function () {
  try {
    tmp = require('tmp');
    tmp.setGracefulCleanup();
  } catch (ignore) {
    archives_disabled = true;
    this.logwarn(
      `the 'tmp' module is required to extract filenames from archives`,
    );
  }
};

exports.load_attachment_ini = function () {
  const plugin = this;

  plugin.cfg = plugin.config.get('attachment.ini', () => {
    plugin.load_attachment_ini();
  });

  plugin.cfg.timeout = (plugin.cfg.main.timeout || 30) * 1000;

  // repair a mismatch between legacy docs and code
  const extns =
    plugin.cfg.archive && plugin.cfg.archive.extensions
      ? plugin.cfg.archive.extensions // new
      : plugin.cfg.main.archive_extensions // old code
        ? plugin.cfg.main.archive_extensions
        : plugin.cfg.main.archive_extns // old docs
          ? plugin.cfg.main.archive_extns
          : 'zip tar tgz taz z gz rar 7z';

  plugin.cfg.archive.exts = this.options_to_object(extns);

  plugin.cfg.archive.max_depth =
    plugin.cfg.archive && plugin.cfg.archive.max_depth
      ? plugin.cfg.archive.max_depth // new
      : plugin.cfg.main.archive_max_depth // old
        ? plugin.cfg.main.archive_max_depth
        : 5;

  plugin.load_dissallowed_extns();
};

exports.find_bsdtar_path = (cb) => {
  let found = false;
  let i = 0;
  ['/bin', '/usr/bin', '/usr/local/bin'].forEach((dir) => {
    if (found) return;
    i++;
    fs.stat(`${dir}/bsdtar`, (err) => {
      i--;
      if (found) return;
      if (err) {
        if (i === 0) cb(new Error('bsdtar not found'));
        return;
      }
      found = true;
      cb(null, dir);
    });
    if (i === 0) cb(new Error('bsdtar not found'));
  });
};

exports.hook_init_master = exports.hook_init_child = function (next) {
  const plugin = this;

  plugin.find_bsdtar_path((err, dir) => {
    if (err) {
      archives_disabled = true;
      plugin.logwarn(
        `This plugin requires the 'bsdtar' binary to extract filenames from archive files`,
      );
    } else {
      plugin.logdebug(`found bsdtar in ${dir}`);
      plugin.bsdtar_path = `${dir}/bsdtar`;
    }
    next();
  });
};

exports.load_dissallowed_extns = function () {
  const plugin = this;

  if (!plugin.cfg.main.disallowed_extensions) return;

  if (!plugin.re) plugin.re = {};
  plugin.re.bad_extn = new RegExp(
    '\\.(?:' +
      plugin.cfg.main.disallowed_extensions
        .replace(/\s+/, ' ')
        .split(/[;, ]/)
        .join('|') +
      ')$',
    'i',
  );
};

exports.load_n_compile_re = function (name, file) {
  const plugin = this;
  const valid_re = [];

  const try_re = plugin.config.get(file, 'list', function () {
    plugin.load_n_compile_re(name, file);
  });

  for (let r = 0; r < try_re.length; r++) {
    try {
      const reg = new RegExp(try_re[r], 'i');
      valid_re.push(reg);
    } catch (e) {
      this.logerror(`skipping invalid regexp: /${try_re[r]}/ (${e})`);
    }
  }

  if (!plugin.re) plugin.re = {};
  plugin.re[name] = valid_re;
};

exports.options_to_object = function (options) {
  if (!options) return false;

  const res = {};
  options
    .toLowerCase()
    .replace(/\s+/, ' ')
    .split(/[;, ]/)
    .forEach((opt) => {
      if (!opt) return;
      res[opt.trim()] = true;
    });

  if (Object.keys(res).length) return res;
  return false;
};

exports.unarchive_recursive = async function (
  connection,
  f,
  archive_file_name,
  cb,
) {
  if (archives_disabled) {
    connection.logdebug(this, 'archive support disabled');
    return cb();
  }

  const plugin = this;
  const tmpfiles = [];

  let timeouted = false;
  let encrypted = false;
  let depthExceeded = false;

  function timeoutedSpawn(cmd_path, args, env, pipe_stdout_ws) {
    connection.logdebug(plugin, `running "${cmd_path} ${args.join(' ')}"`);

    return new Promise(function (resolve, reject) {
      let output = '';
      const p = spawn(cmd_path, args, env);

      // Start timer
      let timeout = false;
      const timer = setTimeout(() => {
        timeout = timeouted = true;
        p.kill();

        reject(`command "${cmd_path} ${args}" timed out`);
      }, plugin.cfg.timeout);

      if (pipe_stdout_ws) {
        p.stdout.pipe(pipe_stdout_ws);
      } else {
        p.stdout.on('data', (data) => (output += data));
      }

      p.stderr.on('data', (data) => {
        if (data.includes('Incorrect passphrase')) {
          encrypted = true;
        }

        // it seems that stderr might be sometimes filled after exit so we rather print it out than wait for result
        connection.logdebug(plugin, `"${cmd_path} ${args.join(' ')}": ${data}`);
      });

      p.on('exit', (code, signal) => {
        if (timeout) return;
        clearTimeout(timer);

        if (code && code > 0) {
          // Error was returned
          return reject(
            `"${cmd_path} ${args.join(' ')}" returned error code: ${code}}`,
          );
        }

        if (signal) {
          // Process terminated due to signal
          return reject(
            `"${cmd_path} ${args.join(' ')}" terminated by signal: ${signal}`,
          );
        }

        resolve(output);
      });
    });
  }

  function createTmp() {
    // might be better to use async version of tmp in future not cb based
    return new Promise((resolve, reject) => {
      tmp.file((err, tmpfile, fd) => {
        if (err) reject(err);

        const t = {};
        t.name = tmpfile;
        t.fd = fd;

        resolve(t);
      });
    });
  }

  async function unpackArchive(in_file, file) {
    const t = await createTmp();
    tmpfiles.push([t.fd, t.name]);

    connection.logdebug(
      plugin,
      `created tmp file: ${t.name} (fd=${t.fd}) for file ${file}`,
    );

    const tws = fs.createWriteStream(t.name);
    try {
      // bsdtar seems to be asking for password if archive is encrypted workaround with --passphrase will end up
      // with "Incorrect passphrase" for encrypted archives, but will be ignored with nonencrypted
      await timeoutedSpawn(
        plugin.bsdtar_path,
        [
          '-Oxf',
          in_file,
          `--include=${file}`,
          '--passphrase',
          'deliberately_invalid',
        ],
        {
          cwd: '/tmp',
          env: {
            LANG: 'C',
          },
        },
        tws,
      );
    } catch (e) {
      connection.logdebug(plugin, e);
    }
    return t;
  }

  async function listArchive(in_file) {
    try {
      const lines = await timeoutedSpawn(
        plugin.bsdtar_path,
        ['-tf', in_file, '--passphrase', 'deliberately_invalid'],
        {
          cwd: '/tmp',
          env: { LANG: 'C' },
        },
      );

      // Extract non-empty filenames
      return lines.split(/\r?\n/).filter((fl) => fl);
    } catch (e) {
      connection.logdebug(plugin, e);
      return [];
    }
  }

  function deleteTempFiles() {
    tmpfiles.forEach((t) => {
      fs.close(t[0], () => {
        connection.logdebug(plugin, `closed fd: ${t[0]}`);
        fs.unlink(t[1], () => {
          connection.logdebug(plugin, `deleted tempfile: ${t[1]}`);
        });
      });
    });
  }

  async function processFile(in_file, prefix, file, depth) {
    let result = [(prefix ? `${prefix}/` : '') + file];

    connection.logdebug(
      plugin,
      `found file: ${prefix ? `${prefix}/` : ''}${file} depth=${depth}`,
    );

    if (!plugin.isArchive(path.extname(file.toLowerCase()))) {
      return result;
    }

    connection.logdebug(
      plugin,
      `need to extract file: ${prefix ? `${prefix}/` : ''}${file}`,
    );

    const t = await unpackArchive(in_file, file);

    // Recurse
    try {
      result = result.concat(
        await listFiles(t.name, (prefix ? `${prefix}/` : '') + file, depth + 1),
      );
    } catch (e) {
      connection.logdebug(plugin, e);
    }

    return result;
  }

  async function listFiles(in_file, prefix, depth) {
    const result = [];
    depth = depth || 0;

    if (timeouted) {
      connection.logdebug(
        plugin,
        `already timeouted, not going to process ${prefix ? `${prefix}/` : ''}${in_file}`,
      );
      return result;
    }

    if (depth >= plugin.cfg.archive.max_depth) {
      depthExceeded = true;
      connection.logdebug(
        plugin,
        `hit maximum depth with ${prefix ? `${prefix}/` : ''}${in_file}`,
      );
      return result;
    }

    const fls = await listArchive(in_file);
    await Promise.all(
      fls.map(async (file) => {
        const output = await processFile(in_file, prefix, file, depth + 1);
        result.push(...output);
      }),
    );

    connection.loginfo(
      plugin,
      `finish (${prefix ? `${prefix}/` : ''}${in_file}): count=${result.length} depth=${depth}`,
    );
    return result;
  }

  setTimeout(() => {
    timeouted = true;
  }, plugin.cfg.timeout);

  const files = await listFiles(f, archive_file_name);
  deleteTempFiles();

  if (timeouted) {
    cb(new Error('archive extraction timeouted'), files);
  } else if (depthExceeded) {
    cb(new Error('maximum archive depth exceeded'), files);
  } else if (encrypted) {
    cb(new Error('archive encrypted'), files);
  } else {
    cb(null, files);
  }
};

exports.compute_and_log_md5sum = function (
  connection,
  ctype,
  filename,
  stream,
) {
  const plugin = this;
  const md5 = crypto.createHash('md5');
  let bytes = 0;

  stream.on('data', (data) => {
    md5.update(data);
    bytes += data.length;
  });

  stream.once('end', () => {
    stream.pause();

    const digest = md5.digest('hex') || '';
    const ct = plugin.content_type(connection, ctype);

    connection.transaction.notes.attachments.push({
      ctype: ct,
      filename,
      extension: plugin.file_extension(filename),
      md5: digest,
    });

    connection.transaction.results.push(plugin, {
      attach: {
        file: filename,
        ctype: ct,
        md5: digest,
        bytes,
      },
      emit: true,
    });
    connection.loginfo(
      plugin,
      `file="${filename}" ctype="${ctype}" md5=${digest} bytes=${bytes}`,
    );
  });
};

exports.file_extension = function (filename) {
  if (!filename) return '';

  const ext_match = filename.match(/\.([^. ]+)$/);
  if (!ext_match || !ext_match[1]) return '';

  return ext_match[1].toLowerCase();
};

exports.content_type = function (connection, ctype) {
  const plugin = this;

  const ct_match = ctype.match(plugin.re.ct);
  if (!ct_match || !ct_match[1]) return 'unknown/unknown';

  connection.logdebug(plugin, `found content type: ${ct_match[1]}`);
  connection.transaction.notes.attachment_ctypes.push(ct_match[1]);
  return ct_match[1].toLowerCase();
};

exports.isArchive = function (file_ext) {
  // check with and without the dot prefixed
  if (this.cfg.archive.exts[file_ext]) return true;
  if (file_ext[0] === '.' && this.cfg.archive.exts[file_ext.substring(1)])
    return true;
  return false;
};

exports.start_attachment = function (
  connection,
  ctype,
  filename,
  body,
  stream,
) {
  const plugin = this;
  const txn = connection?.transaction;

  function next() {
    if (txn?.notes?.attachment_next && txn.notes.attachment_count === 0) {
      return txn.notes.attachment_next();
    }
  }

  let file_ext = '.unknown';

  if (filename) {
    file_ext = plugin.file_extension(filename);
    txn.notes.attachment_files.push(filename);
  }

  plugin.compute_and_log_md5sum(connection, ctype, filename, stream);

  if (!filename) return;

  connection.logdebug(plugin, `found attachment file: ${filename}`);
  // See if filename extension matches archive extension list
  if (archives_disabled || !plugin.isArchive(file_ext)) return;

  connection.logdebug(plugin, `found ${file_ext} on archive list`);
  txn.notes.attachment_count++;

  stream.connection = connection;
  stream.pause();

  tmp.file((err, fn, fd) => {
    function cleanup() {
      fs.close(fd, () => {
        connection.logdebug(plugin, `closed fd: ${fd}`);
        fs.unlink(fn, () => {
          connection.logdebug(plugin, `unlinked: ${fn}`);
        });
      });
      stream.resume();
    }
    if (err) {
      txn.notes.attachment_result = [DENYSOFT, err.message];
      connection.logerror(plugin, `Error writing tempfile: ${err.message}`);
      txn.notes.attachment_count--;
      cleanup();
      stream.resume();
      return next();
    }
    connection.logdebug(
      plugin,
      `Got tmpfile: attachment="${filename}" tmpfile="${fn}" fd={fd}`,
    );

    const ws = fs.createWriteStream(fn);
    stream.pipe(ws);
    stream.resume();

    ws.on('error', (error) => {
      txn.notes.attachment_count--;
      txn.notes.attachment_result = [DENYSOFT, error.message];
      connection.logerror(plugin, `stream error: ${error.message}`);
      cleanup();
      next();
    });

    ws.on('close', () => {
      connection.logdebug(plugin, 'end of stream reached');
      connection.pause();
      plugin.unarchive_recursive(connection, fn, filename, (error, files) => {
        txn.notes.attachment_count--;
        cleanup();
        if (error) {
          connection.logerror(plugin, error.message);
          if (error.message === 'maximum archive depth exceeded') {
            txn.notes.attachment_result = [
              DENY,
              'Message contains nested archives exceeding the maximum depth',
            ];
          } else if (/Encrypted file is unsupported/i.test(error.message)) {
            if (!plugin.cfg.main.allow_encrypted_archives) {
              txn.notes.attachment_result = [
                DENY,
                'Message contains encrypted archive',
              ];
            }
          } else if (/Mac metadata is too large/i.test(error.message)) {
            // Skip this error
          } else {
            if (!connection.relaying) {
              txn.notes.attachment_result = [
                DENYSOFT,
                'Error unpacking archive',
              ];
            }
          }
        }

        txn.notes.attachment_archive_files =
          txn.notes.attachment_archive_files.concat(files);
        connection.resume();
        next();
      });
    });
  });
};

exports.hook_data = function (next, connection) {
  const plugin = this;
  if (!connection?.transaction) return next();
  const txn = connection?.transaction;

  txn.parse_body = 1;
  txn.notes.attachment_count = 0;
  txn.notes.attachments = [];
  txn.notes.attachment_ctypes = [];
  txn.notes.attachment_files = [];
  txn.notes.attachment_archive_files = [];
  txn.attachment_hooks((ctype, filename, body, stream) => {
    plugin.start_attachment(connection, ctype, filename, body, stream);
  });
  next();
};

exports.disallowed_extensions = function (txn) {
  const plugin = this;
  if (!plugin.re.bad_extn) return false;

  let bad = false;
  [txn.notes.attachment_files, txn.notes.attachment_archive_files].forEach(
    (items) => {
      if (bad) return;
      if (!items || !Array.isArray(items)) return;
      for (const extn of items) {
        if (!plugin.re.bad_extn.test(extn)) continue;
        bad = extn.split('.').slice(0).pop();
        break;
      }
    },
  );

  return bad;
};

exports.check_attachments = function (next, connection) {
  const txn = connection?.transaction;
  if (!txn) return next();

  // Check for any stored errors from the attachment hooks
  if (txn.notes.attachment_result) {
    const result = txn.notes.attachment_result;
    return next(result[0], result[1]);
  }

  const ctypes = txn.notes.attachment_ctypes;

  // Add in any content type from message body
  const body = txn.body;
  let body_ct;
  if (body && (body_ct = this.re.ct.exec(body.header.get('content-type')))) {
    connection.logdebug(this, `found content type: ${body_ct[1]}`);
    ctypes.push(body_ct[1]);
  }
  // MIME parts
  if (body && body.children) {
    for (let c = 0; c < body.children.length; c++) {
      let child_ct;
      if (
        body.children[c] &&
        (child_ct = this.re.ct.exec(
          body.children[c].header.get('content-type'),
        ))
      ) {
        connection.logdebug(this, `found content type: ${child_ct[1]}`);
        ctypes.push(child_ct[1]);
      }
    }
  }

  const bad_extn = this.disallowed_extensions(txn);
  if (bad_extn) {
    return next(
      DENY,
      `Message contains disallowed file extension (${bad_extn})`,
    );
  }

  const ctypes_result = this.check_items_against_regexps(ctypes, this.re.ctype);
  if (ctypes_result) {
    connection.loginfo(
      this,
      `match ctype="${ctypes_result[0]}" regexp=/${ctypes_result[1]}/`,
    );
    return next(
      DENY,
      `Message contains unacceptable content type (${ctypes_result[0]})`,
    );
  }

  const files = txn.notes.attachment_files;
  const files_result = this.check_items_against_regexps(files, this.re.file);
  if (files_result) {
    connection.loginfo(
      this,
      `match file="${files_result[0]}" regexp=/${files_result[1]}/`,
    );
    return next(
      DENY,
      `Message contains unacceptable attachment (${files_result[0]})`,
    );
  }

  const archive_files = txn.notes.attachment_archive_files;
  const archives_result = this.check_items_against_regexps(
    archive_files,
    this.re.archive,
  );
  if (archives_result) {
    connection.loginfo(
      this,
      `match file="${archives_result[0]}" regexp=/${archives_result[1]}/`,
    );
    return next(
      DENY,
      `Message contains unacceptable attachment (${archives_result[0]})`,
    );
  }

  next();
};

exports.check_items_against_regexps = function (items, regexps) {
  if (!Array.isArray(regexps) || !Array.isArray(items)) return false;
  if (!regexps?.length || !items?.length) return false;

  for (let r = 0; r < regexps.length; r++) {
    for (let i = 0; i < items.length; i++) {
      if (regexps[r].test(items[i])) return [items[i], regexps[r]];
    }
  }
  return false;
};

exports.wait_for_attachment_hooks = (next, connection) => {
  if (connection?.transaction?.notes?.attachment_count > 0) {
    connection.transaction.notes.attachment_next = next;
  } else {
    next();
  }
};
