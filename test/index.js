'use strict'

const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { describe, it, beforeEach } = require('node:test')

const fixtures = require('haraka-test-fixtures')

const attach = new fixtures.plugin('index')

let plugin, connection, directory

const _set_up = (t, done) => {
  plugin = new fixtures.plugin('attachment')
  plugin.cfg = {}
  plugin.cfg.timeout = 10

  connection = fixtures.connection.createConnection()
  connection.init_transaction()

  connection.logdebug = function (where, message) {
    if (process.env.DEBUG) console.log(message)
  }
  connection.loginfo = function (where, message) {
    console.log(message)
  }

  directory = path.resolve(__dirname, 'fixtures')

  // finds bsdtar
  plugin.register()
  plugin.hook_init_master(done)
}

describe('options_to_object', () => {
  it('converts string to object', () => {
    const expected = { gz: true, zip: true }
    assert.deepEqual(expected, attach.options_to_object('gz zip'))
    assert.deepEqual(expected, attach.options_to_object('gz,zip'))
    assert.deepEqual(expected, attach.options_to_object(' gz , zip '))
  })
})

describe('options_to_object regression', () => {
  it('should split on all whitespace, not just the first', () => {
    const input = 'zip   gz   rar'
    const result = attach.options_to_object(input)
    assert.deepEqual(result, { zip: true, gz: true, rar: true })
  })
})

describe('load_disallowed_extns', () => {
  it('loads comma separated options', () => {
    attach.cfg = { main: { disallowed_extensions: 'exe,scr' } }
    attach.load_disallowed_extns()

    assert.ok(attach.re.bad_extn)
    assert.ok(attach.re.bad_extn.test('bad.scr'))
  })

  it('loads space separated options', () => {
    attach.cfg = { main: { disallowed_extensions: 'dll tnef' } }
    attach.load_disallowed_extns()
    assert.ok(attach.re.bad_extn)
    assert.ok(attach.re.bad_extn.test('bad.dll'))
  })
})

describe('file_extension', () => {
  it('returns a file extension from a filename', () => {
    assert.equal('ext', attach.file_extension('file.ext'))
  })

  it('returns empty string for no extension', () => {
    assert.equal('', attach.file_extension('file'))
  })
})

describe('disallowed_extensions', () => {
  it('blocks filename extensions in attachment_files', () => {
    attach.cfg = { main: { disallowed_extensions: 'exe;scr' } }
    attach.load_disallowed_extns()

    const connection = fixtures.connection.createConnection()
    connection.init_transaction()
    const txn = connection.transaction

    txn.notes.attachment_files = ['naughty.exe']
    assert.equal('exe', attach.disallowed_extensions(txn))

    txn.notes.attachment_files = ['good.pdf', 'naughty.exe']
    assert.equal('exe', attach.disallowed_extensions(txn))
  })

  it('blocks filename extensions in archive_files', () => {
    attach.cfg = { main: { disallowed_extensions: 'dll tnef' } }
    attach.load_disallowed_extns()

    const connection = fixtures.connection.createConnection()
    connection.init_transaction()
    const txn = connection.transaction
    txn.notes.attachment = {}

    txn.notes.attachment_archive_files = ['icky.tnef']
    assert.equal('tnef', attach.disallowed_extensions(txn))

    txn.notes.attachment_archive_files = ['good.pdf', 'naughty.dll']
    assert.equal('dll', attach.disallowed_extensions(txn))

    txn.notes.attachment_archive_files = ['good.pdf', 'better.png']
    assert.equal(false, attach.disallowed_extensions(txn))
  })
})

describe('load_n_compile_re', () => {
  it('loads regex lines from file, compiles to array', () => {
    attach.load_n_compile_re('test', 'attachment.filename.regex')
    assert.ok(attach.re.test)
    assert.ok(attach.re.test[0].test('foo.exe'))
  })
})

describe('check_items_against_regexps', () => {
  it('positive', () => {
    attach.load_n_compile_re('test', 'attachment.filename.regex')

    assert.ok(attach.check_items_against_regexps(['file.exe'], attach.re.test))
    assert.ok(attach.check_items_against_regexps(['fine.pdf', 'awful.exe'], attach.re.test))
  })

  it('negative', () => {
    attach.load_n_compile_re('test', 'attachment.filename.regex')

    assert.ok(!attach.check_items_against_regexps(['file.png'], attach.re.test))
    assert.ok(!attach.check_items_against_regexps(['fine.pdf', 'godiva.chocolate'], attach.re.test))
  })
})

describe('isArchive', () => {
  it('zip', () => {
    attach.load_attachment_ini()
    // console.log(attach.cfg.archive);
    assert.equal(true, attach.isArchive('.zip'))
    assert.equal(true, attach.isArchive('zip'))
  })

  it('png', () => {
    attach.load_attachment_ini()
    assert.equal(false, attach.isArchive('.png'))
    assert.equal(false, attach.isArchive('png'))
  })

  it('returns false for undefined archive config', () => {
    const plugin = new fixtures.plugin('attachment')
    plugin.cfg = { archive: { exts: {} } }
    assert.equal(plugin.isArchive('foo'), false)
  })

  it('returns true for extension in exts', () => {
    const plugin = new fixtures.plugin('attachment')
    plugin.cfg = { archive: { exts: { zip: true } } }
    assert.equal(plugin.isArchive('zip'), true)
  })

  it('returns true for .ext in exts', () => {
    const plugin = new fixtures.plugin('attachment')
    plugin.cfg = { archive: { exts: { zip: true } } }
    assert.equal(plugin.isArchive('.zip'), true)
  })
})

describe('content_type', () => {
  it('returns unknown/unknown for invalid ctype', () => {
    const plugin = new fixtures.plugin('attachment')
    const connection = {
      transaction: { notes: { attachment_ctypes: [] } },
      logdebug: () => {},
    }
    plugin.re = { ct: /^([^/]+\/[^;\r\n ]+)/ }
    const result = plugin.content_type(connection, 'not a type')
    assert.equal(result, 'unknown/unknown')
  })
})

describe('unarchive_recursive', () => {
  beforeEach(_set_up)
  it('3layers', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/3layer.zip`, '3layer.zip')
    assert.equal(files.length, 3)
  })

  it('empty.gz', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/empty.gz`, 'empty.gz')
    assert.equal(files.length, 0)
  })

  it('encrypt.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/encrypt.zip`, 'encrypt.zip')
    // we see files list in encrypted zip, but we can't extract so no error here
    assert.equal(files?.length, 1)
  })

  it('encrypt-recursive.zip', async () => {
    if (!plugin.bsdtar_path) return
    try {
      await plugin.unarchive_recursive(
        connection,
        `${directory}/encrypt-recursive.zip`,
        'encrypt-recursive.zip',
      )
      throw new Error('expected encrypted error')
    } catch (e) {
      // we can't extract encrypted file in encrypted zip so error here
      assert.equal(true, e.message.includes('encrypted'))
      const files = e.files || []
      assert.equal(files.length, 1)
    }
  })

  it('gz-in-zip.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/gz-in-zip.zip`, 'gz-in-zip.zip')
    // gz is not listable in bsdtar
    assert.equal(files.length, 1)
  })

  it('invalid.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/invalid.zip`, 'invalid.zip')
    // invalid zip is assumed to be just file, so error of bsdtar is ignored
    assert.equal(files.length, 0)
  })

  it('invalid-in-valid.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(
      connection,
      `${directory}/invalid-in-valid.zip`,
      'invalid-in-valid.zip',
    )
    assert.equal(files.length, 1)
  })

  it('password.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/password.zip`, 'password.zip')
    // we see files list in encrypted zip, but we can't extract so no error here
    assert.equal(files.length, 1)
  })

  it('valid.zip', async () => {
    if (!plugin.bsdtar_path) return
    const files = await plugin.unarchive_recursive(connection, `${directory}/valid.zip`, 'valid.zip')
    assert.equal(files.length, 1)
  })

  it('timeout', async () => {
    if (!plugin.bsdtar_path) return
    plugin.cfg.timeout = 0
    try {
      await plugin.unarchive_recursive(
        connection,
        `${directory}/encrypt-recursive.zip`,
        'encrypt-recursive.zip',
      )
      throw new Error('expected timeout error')
    } catch (e) {
      assert.ok(e.message.includes('timeout'))
      const files = e.files || []
      assert.equal(files.length, 0)
    }
  })
})

describe('start_attachment', () => {
  beforeEach(_set_up)

  it('finds an message attachment', async () => {
    // const pi = plugin
    const txn = connection.transaction

    await new Promise((resolve) => {
      plugin.hook_data(function () {
        // console.log(pi)
        const msgPath = path.join(__dirname, 'fixtures', 'haraka-icon-attach.eml')
        // console.log(`msgPath: ${msgPath}`)
        const specimen = fs.readFileSync(msgPath, 'utf8')

        for (const line of specimen.split(/\r?\n/g)) {
          txn.add_data(`${line}\r\n`)
        }

        txn.end_data()
        txn.ensure_body()

        // console.dir(txn.message_stream)
        assert.deepEqual(txn.message_stream.idx['Apple-Mail=_65C16661-5FA8-4757-B627-13E55C40C8D7'], {
          start: 5232,
          end: 6384,
        })
        resolve()
      }, connection)
    })
  })
})

describe('wait_for_attachment_hooks and start_attachment (md5 only)', () => {
  // beforeEach(_set_up)

  it('wait_for_attachment_hooks sets attachment_next when count > 0', (t, done) => {
    const plugin = new fixtures.plugin('attachment')
    const connection = fixtures.connection.createConnection()
    connection.init_transaction()
    connection.transaction.notes.attachment_count = 1

    plugin.wait_for_attachment_hooks(function () {
      // should not be called immediately
      done(new Error('next should not be called'))
    }, connection)

    // ensure attachment_next was set
    setImmediate(() => {
      if (connection.transaction.notes.attachment_next) return done()
      done(new Error('attachment_next not set'))
    })
  })

  it('start_attachment computes md5 and records attachment when no filename', (t, done) => {
    const plugin = new fixtures.plugin('attachment')
    const connection = fixtures.connection.createConnection()
    connection.init_transaction()
    const txn = connection.transaction
    txn.notes.attachments = []
    txn.notes.attachment_ctypes = []

    const { PassThrough } = require('stream')
    const stream = new PassThrough()

    // call start_attachment with no filename -> should only compute md5
    plugin.start_attachment(connection, 'application/octet-stream', null, null, stream)

    // write some data and end
    stream.write('hello world')
    stream.end()

    // wait for async md5 handler to run
    setTimeout(() => {
      try {
        if (!txn.notes.attachments || txn.notes.attachments.length === 0) {
          return done(new Error('no attachment recorded'))
        }
        const a = txn.notes.attachments[0]
        if (!a.md5) return done(new Error('md5 missing'))
        done()
      } catch (e) {
        done(e)
      }
    }, 20)
  })
})

describe('check_attachments', () => {
  const constants = require('haraka-constants')

  const mkPlugin = (re = {}) => {
    const p = new fixtures.plugin('attachment')
    p.cfg = { main: {} }
    p.re = {
      ct: /^([^/]+\/[^;\r\n ]+)/,
      ctype: [],
      file: [],
      archive: [],
      ...re,
    }
    return p
  }

  const mkConn = (notes = {}) => {
    const c = fixtures.connection.createConnection()
    c.init_transaction()
    Object.assign(c.transaction.notes, {
      attachment_ctypes: [],
      attachment_files: [],
      attachment_archive_files: [],
      ...notes,
    })
    c.logdebug = () => {}
    c.loginfo = () => {}
    return c
  }

  const run = (p, c) => new Promise((res) => p.check_attachments((...a) => res(a), c))

  it('no transaction -> next()', async () => {
    assert.deepEqual(await run(mkPlugin(), {}), [])
  })

  it('relays a stored attachment_result', async () => {
    const c = mkConn({ attachment_result: [constants.DENYSOFT, 'boom'] })
    assert.deepEqual(await run(mkPlugin(), c), [constants.DENYSOFT, 'boom'])
  })

  it('DENYs a disallowed file extension', async () => {
    const p = mkPlugin({ bad_extn: /\.(exe)$/i })
    const c = mkConn({ attachment_files: ['resume.exe'] })
    const [code, msg] = await run(p, c)
    assert.equal(code, constants.DENY)
    assert.match(msg, /disallowed file extension \(exe\)/)
  })

  it('DENYs an unacceptable content type', async () => {
    const p = mkPlugin({ ctype: [/application\/x-bad/] })
    const c = mkConn({ attachment_ctypes: ['application/x-bad'] })
    const [code, msg] = await run(p, c)
    assert.equal(code, constants.DENY)
    assert.match(msg, /unacceptable content type/)
  })

  it('DENYs an unacceptable filename', async () => {
    const p = mkPlugin({ file: [/\.scr$/] })
    const c = mkConn({ attachment_files: ['photo.scr'] })
    const [code, msg] = await run(p, c)
    assert.equal(code, constants.DENY)
    assert.match(msg, /unacceptable attachment \(photo\.scr\)/)
  })

  it('DENYs an unacceptable archived filename', async () => {
    const p = mkPlugin({ archive: [/payload\.js$/] })
    const c = mkConn({ attachment_archive_files: ['a/payload.js'] })
    const [code] = await run(p, c)
    assert.equal(code, constants.DENY)
  })

  it('extracts content types from the body and MIME children', async () => {
    const p = mkPlugin({ ctype: [/application\/zip/] })
    const c = mkConn()
    c.transaction.body = {
      header: { get: () => 'application/zip; charset=x' },
      children: [{ header: { get: () => 'image/png' } }],
    }
    const [code] = await run(p, c)
    assert.equal(code, constants.DENY) // matched the body content-type
  })

  it('passes a clean message', async () => {
    const c = mkConn({
      attachment_ctypes: ['text/plain'],
      attachment_files: ['notes.txt'],
    })
    assert.deepEqual(await run(mkPlugin(), c), [])
  })
})

describe('hook_data / content_type / start_attachment', () => {
  it('hook_data with no transaction calls next()', async () => {
    const p = new fixtures.plugin('attachment')
    const args = await new Promise((res) => p.hook_data((...a) => res(a), {}))
    assert.deepEqual(args, [])
  })

  it('hook_data initializes txn notes and registers the hook', async () => {
    const p = new fixtures.plugin('attachment')
    const c = fixtures.connection.createConnection()
    c.init_transaction()
    let hooked = false
    c.transaction.attachment_hooks = () => (hooked = true)
    await new Promise((res) => p.hook_data((...a) => res(a), c))
    assert.equal(c.transaction.parse_body, 1)
    assert.deepEqual(c.transaction.notes.attachment_ctypes, [])
    assert.ok(hooked)
  })

  it('content_type records a recognized type', () => {
    const p = new fixtures.plugin('attachment')
    p.re = { ct: /^([^/]+\/[^;\r\n ]+)/ }
    const c = {
      transaction: { notes: { attachment_ctypes: [] } },
      logdebug: () => {},
    }
    assert.equal(p.content_type(c, 'application/zip; charset=utf-8'), 'application/zip')
    assert.deepEqual(c.transaction.notes.attachment_ctypes, ['application/zip'])
  })

  it('start_attachment records a non-archive filename', () => {
    const p = new fixtures.plugin('attachment')
    p.cfg = { main: {} }
    p.compute_and_log_md5sum = () => {}
    const c = fixtures.connection.createConnection()
    c.init_transaction()
    c.transaction.notes.attachment_files = []
    c.logdebug = () => {}
    p.start_attachment(c, 'text/plain', 'readme.txt', null, {})
    assert.deepEqual(c.transaction.notes.attachment_files, ['readme.txt'])
  })
})

describe('start_attachment archive extraction', () => {
  beforeEach(_set_up)

  it('extracts a real zip via the attachment pipeline', (t, done) => {
    if (!plugin.bsdtar_path) return done() // bsdtar not installed
    const txn = connection.transaction
    txn.notes.attachment_count = 0
    txn.notes.attachment_files = []
    txn.notes.attachment_archive_files = []
    connection.pause = () => {}
    connection.resume = () => {}
    plugin.compute_and_log_md5sum = () => {}
    txn.notes.attachment_next = () => {
      try {
        assert.ok(txn.notes.attachment_archive_files.length >= 1, 'archive contents were listed')
        done()
      } catch (e) {
        done(e)
      }
    }
    const stream = fs.createReadStream(`${directory}/valid.zip`)
    plugin.start_attachment(connection, 'application/zip', 'valid.zip', null, stream)
  })

  it('DENYs when archive nesting exceeds max_depth', (t, done) => {
    if (!plugin.bsdtar_path) return done()
    const txn = connection.transaction
    txn.notes.attachment_count = 0
    txn.notes.attachment_files = []
    txn.notes.attachment_archive_files = []
    plugin.cfg.archive.max_depth = 1 // 3layer.zip nests deeper
    connection.pause = () => {}
    connection.resume = () => {}
    plugin.compute_and_log_md5sum = () => {}
    txn.notes.attachment_next = () => {
      try {
        assert.ok(Array.isArray(txn.notes.attachment_result))
        assert.equal(txn.notes.attachment_result[0], require('haraka-constants').DENY)
        done()
      } catch (e) {
        done(e)
      }
    }
    const stream = fs.createReadStream(`${directory}/3layer.zip`)
    plugin.start_attachment(connection, 'application/zip', '3layer.zip', null, stream)
  })
})

describe('config & init branches', () => {
  it('hook_init_master disables archives when bsdtar is absent', (t, done) => {
    const p = new fixtures.plugin('attachment')
    p.find_bsdtar_path = async () => {
      throw new Error('nope')
    }
    p.hook_init_master(() => {
      assert.equal(p.bsdtar_path, undefined)
      done()
    })
  })

  it('load_attachment_ini honors legacy archive_extensions config', () => {
    const p = new fixtures.plugin('attachment')
    p.config.get = () => ({
      main: { archive_extensions: 'zip rar', archive_max_depth: 9 },
      archive: {},
    })
    p.load_attachment_ini()
    assert.equal(p.cfg.archive.exts.zip, true)
    assert.equal(p.cfg.archive.exts.rar, true)
    assert.equal(p.cfg.archive.max_depth, 9)
  })
})
