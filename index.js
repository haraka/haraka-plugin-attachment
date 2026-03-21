'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

let tmp
let archives_disabled = false

exports.re = {
  ct: /^([^/]+\/[^;\r\n ]+)/, // content type
}

exports.register = function () {
  this.load_tmp_module()
  this.load_attachment_ini()

  this.load_n_compile_re('file', 'attachment.filename.regex')
  this.load_n_compile_re('ctype', 'attachment.ctype.regex')
  this.load_n_compile_re('archive', 'attachment.archive.filename.regex')

  this.register_hook('data_post', 'wait_for_attachment_hooks')
  this.register_hook('data_post', 'check_attachments')
}

exports.load_tmp_module = function () {
  try {
    tmp = require('tmp')
    tmp.setGracefulCleanup()
  } catch (ignore) {
    archives_disabled = true
    this.logwarn(`the 'tmp' module is required to extract filenames from archives`)
  }
}

exports.load_attachment_ini = function () {
  this.cfg = this.config.get('attachment.ini', () => {
    this.load_attachment_ini()
  })

  this.cfg.timeout = (this.cfg.main.timeout || 30) * 1000

  // repair a mismatch between legacy docs and code
  const extns = this.cfg.archive?.extensions
    ? this.cfg.archive.extensions // new
    : this.cfg.main.archive_extensions // old code
      ? this.cfg.main.archive_extensions
      : this.cfg.main.archive_extns // old docs
        ? this.cfg.main.archive_extns
        : 'zip tar tgz taz z gz rar 7z'

  this.cfg.archive.exts = this.options_to_object(extns)

  this.cfg.archive.max_depth = this.cfg.archive?.max_depth
    ? this.cfg.archive.max_depth // new
    : this.cfg.main.archive_max_depth // old
      ? this.cfg.main.archive_max_depth
      : 5

  this.load_disallowed_extns()
}

exports.find_bsdtar_path = async function () {
  const dirs = ['/bin', '/usr/bin', '/usr/local/bin']
  for (const dir of dirs) {
    try {
      await fs.promises.stat(`${dir}/bsdtar`)
      return dir
    } catch (ignore) {
      // not present in this directory, continue
    }
  }
  throw new Error('bsdtar not found')
}

exports.hook_init_master = exports.hook_init_child = function (next) {

  this
    .find_bsdtar_path()
    .then((dir) => {
      this.logdebug(`found bsdtar in ${dir}`)
      this.bsdtar_path = `${dir}/bsdtar`
      next()
    })
    .catch(() => {
      archives_disabled = true
      this.logwarn(
        `This plugin requires the 'bsdtar' binary to extract filenames from archive files`,
      )
      next()
    })
}

exports.load_disallowed_extns = function () {
  if (!this.cfg.main.disallowed_extensions) return

  const extnList = this.cfg.main.disallowed_extensions
    .replace(/\s+/g, ' ')
    .split(/[;, ]/)
    .map((e) => e.trim())
    .filter(Boolean)
    .join('|')

  if (!this.re) this.re = {}
  this.re.bad_extn = new RegExp(`\\.(?:${extnList})$`, 'i')
}

exports.load_n_compile_re = function (name, file) {
  const valid_re = []

  const try_re = this.config.get(file, 'list', () => {
    this.load_n_compile_re(name, file)
  })

  for (let r = 0; r < try_re.length; r++) {
    try {
      const reg = new RegExp(try_re[r], 'i')
      valid_re.push(reg)
    } catch (e) {
      this.logerror(`skipping invalid regexp: /${try_re[r]}/ (${e})`)
    }
  }

  if (!this.re) this.re = {}
  this.re[name] = valid_re
}

exports.options_to_object = function (options) {
  if (!options) return false

  const res = {}
  for (const opt of options.toLowerCase().replace(/\s+/g, ' ').split(/[;, ]/)) {
    if (!opt) continue
    res[opt.trim()] = true
  }

  if (Object.keys(res).length) return res
  return false
}

exports.timedOutSpawn = async function (plugin, connection, cmd_path, args, env, pipe_stdout_ws, ctx) {
  connection.logdebug(plugin, `running "${cmd_path} ${args.join(' ')}"`)

  return new Promise(function (resolve, reject) {
    let output = ''
    const p = spawn(cmd_path, args, env)

    // Start timer
    let timeout = false
    const timer = setTimeout(() => {
      timeout = ctx.timeouted = true
      p.kill()

      reject(`command "${cmd_path} ${args}" timed out`)
    }, plugin.cfg.timeout)

    if (pipe_stdout_ws) {
      p.stdout.pipe(pipe_stdout_ws)
    } else {
      p.stdout.on('data', (data) => (output += data))
    }

    p.stderr.on('data', (data) => {
      if (String(data).includes('Incorrect passphrase')) {
        ctx.encrypted = true
      }
      connection.logdebug(plugin, `"${cmd_path} ${args.join(' ')}": ${data}`)
    })

    p.on('exit', (code, signal) => {
      if (timeout) return
      clearTimeout(timer)

      if (code && code > 0) {
        return reject(`"${cmd_path} ${args.join(' ')}" returned error code: ${code}`)
      }

      if (signal) {
        return reject(`"${cmd_path} ${args.join(' ')}" terminated by signal: ${signal}`)
      }

      resolve(output)
    })
  })
}

exports.createTmp = function () {
  return new Promise((resolve, reject) => {
    tmp.file((err, tmpfile, fd) => {
      if (err) return reject(err)
      resolve({ name: tmpfile, fd })
    })
  })
}

exports.unpackArchive = async function (plugin, connection, in_file, file, ctx) {
  const t = await this.createTmp()
  ctx.tmpfiles.push([t.fd, t.name])

  connection.logdebug(plugin, `created tmp file: ${t.name} (fd=${t.fd}) for file ${file}`)

  const tws = fs.createWriteStream(t.name)
  try {
    await this.timedOutSpawn(
      plugin,
      connection,
      plugin.bsdtar_path,
      ['-Oxf', in_file, `--include=${file}`, '--passphrase', 'deliberately_invalid'],
      { cwd: '/tmp', env: { LANG: 'C' } },
      tws,
      ctx,
    )
  } catch (e) {
    connection.logdebug(plugin, e)
  }
  return t
}

exports.listArchive = async function (plugin, connection, in_file, ctx) {
  try {
    const lines = await this.timedOutSpawn(
      plugin,
      connection,
      plugin.bsdtar_path,
      ['-tf', in_file, '--passphrase', 'deliberately_invalid'],
      { cwd: '/tmp', env: { LANG: 'C' } },
      null,
      ctx,
    )
    return String(lines).split(/\r?\n/).filter((fl) => fl)
  } catch (e) {
    connection.logdebug(plugin, e)
    return []
  }
}

exports.deleteTempFiles = function (plugin, connection, ctx) {
  for (const [fd, name] of ctx.tmpfiles) {
    fs.close(fd, () => {
      connection.logdebug(plugin, `closed fd: ${fd}`)
      fs.unlink(name, () => {
        connection.logdebug(plugin, `deleted tempfile: ${name}`)
      })
    })
  }
}

exports.processFile = async function (plugin, connection, in_file, prefix, file, depth, ctx) {
  let result = [(prefix ? `${prefix}/` : '') + file]

  connection.logdebug(plugin, `found file: ${prefix ? `${prefix}/` : ''}${file} depth=${depth}`)

  if (!plugin.isArchive(path.extname(file.toLowerCase()))) {
    return result
  }

  connection.logdebug(plugin, `need to extract file: ${prefix ? `${prefix}/` : ''}${file}`)

  const t = await this.unpackArchive(plugin, connection, in_file, file, ctx)

  try {
    result = result.concat(await this.listFiles(plugin, connection, t.name, (prefix ? `${prefix}/` : '') + file, depth + 1, ctx))
  } catch (e) {
    connection.logdebug(plugin, e)
  }

  return result
}

exports.listFiles = async function (plugin, connection, in_file, prefix, depth, ctx) {
  const result = []
  depth = depth || 0

  if (ctx.timeouted) {
    connection.logdebug(plugin, `already timeouted, not going to process ${prefix ? `${prefix}/` : ''}${in_file}`)
    return result
  }

  if (depth >= plugin.cfg.archive.max_depth) {
    ctx.depthExceeded = true
    connection.logdebug(plugin, `hit maximum depth with ${prefix ? `${prefix}/` : ''}${in_file}`)
    return result
  }

  const fls = await this.listArchive(plugin, connection, in_file, ctx)
  await Promise.all(
    fls.map(async (file) => {
      const output = await this.processFile(plugin, connection, in_file, prefix, file, depth + 1, ctx)
      result.push(...output)
    }),
  )

  connection.loginfo(plugin, `finish (${prefix ? `${prefix}/` : ''}${in_file}): count=${result.length} depth=${depth}`)
  return result
}

exports.unarchive_recursive = async function (connection, f, archive_file_name) {
  if (archives_disabled) {
    connection.logdebug(this, 'archive support disabled')
    return []
  }

  const ctx = { tmpfiles: [], timeouted: false, encrypted: false, depthExceeded: false }

  setTimeout(() => {
    ctx.timeouted = true
  }, this.cfg.timeout)

  const files = await this.listFiles(this, connection, f, archive_file_name, 0, ctx)
  this.deleteTempFiles(this, connection, ctx)

  if (ctx.timeouted) {
    const err = new Error('archive extraction timeouted')
    err.files = files
    throw err
  } else if (ctx.depthExceeded) {
    const err = new Error('maximum archive depth exceeded')
    err.files = files
    throw err
  } else if (ctx.encrypted) {
    const err = new Error('archive encrypted')
    err.files = files
    throw err
  }

  return files
}

exports.compute_and_log_md5sum = function (connection, ctype, filename, stream) {
  const plugin = this
  const md5 = crypto.createHash('md5')
  let bytes = 0

  stream.on('data', (data) => {
    md5.update(data)
    bytes += data.length
  })

  stream.once('end', () => {
    stream.pause()

    const digest = md5.digest('hex') || ''
    const ct = plugin.content_type(connection, ctype)

    connection.transaction.notes.attachments.push({
      ctype: ct,
      filename,
      extension: plugin.file_extension(filename),
      md5: digest,
    })

    connection.transaction.results.push(plugin, {
      attach: {
        file: filename,
        ctype: ct,
        md5: digest,
        bytes,
      },
      emit: true,
    })
    connection.loginfo(
      plugin,
      `file="${filename}" ctype="${ctype}" md5=${digest} bytes=${bytes}`,
    )
  })
}

exports.file_extension = function (filename) {
  if (!filename) return ''

  const ext_match = filename.match(/\.([^. ]+)$/)
  if (!ext_match || !ext_match[1]) return ''

  return ext_match[1].toLowerCase()
}

exports.content_type = function (connection, ctype) {
  const plugin = this

  const ct_match = ctype.match(plugin.re.ct)
  if (!ct_match || !ct_match[1]) return 'unknown/unknown'

  connection.logdebug(plugin, `found content type: ${ct_match[1]}`)
  connection.transaction.notes.attachment_ctypes.push(ct_match[1])
  return ct_match[1].toLowerCase()
}

exports.isArchive = function (file_ext) {
  // check with and without the dot prefixed
  const exts = this.cfg?.archive?.exts ?? false
  if (!exts) return false
  if (exts[file_ext]) return true
  if (file_ext && file_ext[0] === '.' && exts[file_ext.substring(1)]) return true
  return false
}

exports.start_attachment = function (connection, ctype, filename, body, stream) {
  const plugin = this
  const txn = connection?.transaction

  function next() {
    if (txn?.notes?.attachment_next && txn.notes.attachment_count === 0) {
      return txn.notes.attachment_next()
    }
  }

  let file_ext = '.unknown'

  if (filename) {
    file_ext = plugin.file_extension(filename)
    txn.notes.attachment_files.push(filename)
  }

  plugin.compute_and_log_md5sum(connection, ctype, filename, stream)

  if (!filename) return

  connection.logdebug(plugin, `found attachment file: ${filename}`)
  // See if filename extension matches archive extension list
  if (archives_disabled || !plugin.isArchive(file_ext)) return

  connection.logdebug(plugin, `found ${file_ext} on archive list`)
  txn.notes.attachment_count++

  stream.connection = connection
  stream.pause()

  tmp.file((err, fn, fd) => {
    function cleanup() {
      fs.close(fd, () => {
        connection.logdebug(plugin, `closed fd: ${fd}`)
        fs.unlink(fn, () => {
          connection.logdebug(plugin, `unlinked: ${fn}`)
        })
      })
      stream.resume()
    }
    if (err) {
      txn.notes.attachment_result = [DENYSOFT, err.message]
      connection.logerror(plugin, `Error writing tempfile: ${err.message}`)
      txn.notes.attachment_count--
      cleanup()
      stream.resume()
      return next()
    }
    connection.logdebug(
      plugin,
      `Got tmpfile: attachment="${filename}" tmpfile="${fn}" fd=${fd}`,
    )

    const ws = fs.createWriteStream(fn)
    stream.pipe(ws)
    stream.resume()

    ws.on('error', (error) => {
      txn.notes.attachment_count--
      txn.notes.attachment_result = [DENYSOFT, error.message]
      connection.logerror(plugin, `stream error: ${error.message}`)
      cleanup()
      next()
    })

    ws.on('close', () => {
      connection.logdebug(plugin, 'end of stream reached')
      connection.pause()
      plugin
        .unarchive_recursive(connection, fn, filename)
        .then((files) => {
          txn.notes.attachment_count--
          cleanup()
          txn.notes.attachment_archive_files =
            txn.notes.attachment_archive_files.concat(files)
          connection.resume()
          next()
        })
        .catch((error) => {
          txn.notes.attachment_count--
          cleanup()
          connection.logerror(plugin, error.message)
          if (error.message === 'maximum archive depth exceeded') {
            txn.notes.attachment_result = [
              DENY,
              'Message contains nested archives exceeding the maximum depth',
            ]
          } else if (/Encrypted file is unsupported/i.test(error.message)) {
            if (!plugin.cfg.main.allow_encrypted_archives) {
              txn.notes.attachment_result = [DENY, 'Message contains encrypted archive']
            }
          } else if (/Mac metadata is too large/i.test(error.message)) {
            // Skip this error
          } else {
            if (!connection.relaying) {
              txn.notes.attachment_result = [DENYSOFT, 'Error unpacking archive']
            }
          }

          const files = error.files || []
          txn.notes.attachment_archive_files =
            txn.notes.attachment_archive_files.concat(files)
          connection.resume()
          next()
        })
    })
  })
}

exports.hook_data = function (next, connection) {
  if (!connection?.transaction) return next()
  const txn = connection?.transaction

  txn.parse_body = 1
  txn.notes.attachment_count = 0
  txn.notes.attachments = []
  txn.notes.attachment_ctypes = []
  txn.notes.attachment_files = []
  txn.notes.attachment_archive_files = []
  txn.attachment_hooks((ctype, filename, body, stream) => {
    this.start_attachment(connection, ctype, filename, body, stream)
  })
  next()
}

exports.disallowed_extensions = function (txn) {
  if (!this.re.bad_extn) return false

  let bad = false
  for (const items of [txn.notes.attachment_files, txn.notes.attachment_archive_files]) {
    if (bad) continue
    if (!items || !Array.isArray(items)) continue
    for (const extn of items) {
      if (!this.re.bad_extn.test(extn)) continue
      bad = extn.split('.').slice(0).pop()
      break
    }
  }

  return bad
}

exports.check_attachments = function (next, connection) {
  const txn = connection?.transaction
  if (!txn) return next()

  // Check for any stored errors from the attachment hooks
  if (txn.notes.attachment_result) {
    const result = txn.notes.attachment_result
    return next(result[0], result[1])
  }

  const ctypes = txn.notes.attachment_ctypes

  // Add in any content type from message body
  const body = txn.body
  let body_ct
  if (body && (body_ct = this.re.ct.exec(body.header.get('content-type')))) {
    connection.logdebug(this, `found content type: ${body_ct[1]}`)
    ctypes.push(body_ct[1])
  }
  // MIME parts
  if (body && body.children) {
    for (let c = 0; c < body.children.length; c++) {
      let child_ct
      if (
        body.children[c] &&
        (child_ct = this.re.ct.exec(body.children[c].header.get('content-type')))
      ) {
        connection.logdebug(this, `found content type: ${child_ct[1]}`)
        ctypes.push(child_ct[1])
      }
    }
  }

  const bad_extn = this.disallowed_extensions(txn)
  if (bad_extn) {
    return next(DENY, `Message contains disallowed file extension (${bad_extn})`)
  }

  const ctypes_result = this.check_items_against_regexps(ctypes, this.re.ctype)
  if (ctypes_result) {
    connection.loginfo(
      this,
      `match ctype="${ctypes_result[0]}" regexp=/${ctypes_result[1]}/`,
    )
    return next(DENY, `Message contains unacceptable content type (${ctypes_result[0]})`)
  }

  const files = txn.notes.attachment_files
  const files_result = this.check_items_against_regexps(files, this.re.file)
  if (files_result) {
    connection.loginfo(
      this,
      `match file="${files_result[0]}" regexp=/${files_result[1]}/`,
    )
    return next(DENY, `Message contains unacceptable attachment (${files_result[0]})`)
  }

  const archive_files = txn.notes.attachment_archive_files
  const archives_result = this.check_items_against_regexps(archive_files, this.re.archive)
  if (archives_result) {
    connection.loginfo(
      this,
      `match file="${archives_result[0]}" regexp=/${archives_result[1]}/`,
    )
    return next(DENY, `Message contains unacceptable attachment (${archives_result[0]})`)
  }

  next()
}

exports.check_items_against_regexps = function (items, regexps) {
  if (!Array.isArray(regexps) || !Array.isArray(items)) return false
  if (!regexps?.length || !items?.length) return false

  for (const re of regexps) {
    for (const item of items) {
      if (re.test(item)) return [item, re]
    }
  }
  return false
}

exports.wait_for_attachment_hooks = (next, connection) => {
  if (connection?.transaction?.notes?.attachment_count > 0) {
    connection.transaction.notes.attachment_next = next
  } else {
    next()
  }
}
