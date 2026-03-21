'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const fixtures = require('haraka-test-fixtures')

describe('internal helper functions', function () {
  let plugin
  let connection

  beforeEach(function () {
    plugin = new fixtures.plugin('attachment')
    // ensure tmp module is available for createTmp
    plugin.load_tmp_module()

    plugin.cfg = {}
    plugin.cfg.timeout = 100
    plugin.cfg.archive = { exts: { zip: true }, max_depth: 5 }

    connection = fixtures.connection.createConnection()
    connection.init_transaction()
    connection.logdebug = function () {}
    connection.loginfo = function () {}
  })

  it('createTmp creates a temp file and returns fd/name', async function () {
    if (!plugin) throw new Error('plugin missing')
    const t = await plugin.createTmp()
    assert.ok(t && t.name && typeof t.fd === 'number')
    // file should exist
    assert.ok(fs.existsSync(t.name))
    // cleanup
    try {
      fs.closeSync(t.fd)
    } catch (ignore) {}
    fs.unlinkSync(t.name)
  })

  it('timedOutSpawn resolves output and detects timeouts', async function () {
    const ctx = { timeouted: false, encrypted: false }
    // quick command
    const out = await plugin.timedOutSpawn(
      plugin,
      connection,
      process.execPath,
      ['-e', 'console.log("hello")'],
      { cwd: process.cwd(), env: process.env },
      null,
      ctx,
    )
    assert.ok(String(out).includes('hello'))

    // trigger timeout using sleep and very short timeout
    plugin.cfg.timeout = 1
    const ctx2 = { timeouted: false, encrypted: false }
    try {
      await plugin.timedOutSpawn(
        plugin,
        connection,
        process.execPath,
        ['-e', 'setTimeout(() => {}, 1000)'],
        { cwd: process.cwd(), env: process.env },
        null,
        ctx2,
      )
      throw new Error('expected timeout')
    } catch (e) {
      assert.ok(String(e).toLowerCase().includes('timed out') || ctx2.timeouted)
    }
  })

  it('deleteTempFiles closes and removes temp files', function (done) {
    const name = path.join(os.tmpdir(), `att-test-${Date.now()}`)
    const fd = fs.openSync(name, 'w')
    fs.writeSync(fd, 'x')

    const ctx = { tmpfiles: [[fd, name]] }

    plugin.deleteTempFiles(plugin, connection, ctx)

    setTimeout(() => {
      assert.equal(false, fs.existsSync(name))
      done()
    }, 50)
  })

  it('listFiles honors max depth and sets depthExceeded', async function () {
    plugin.cfg.archive.max_depth = 0
    const ctx = { tmpfiles: [], timeouted: false, encrypted: false, depthExceeded: false }
    const res = await plugin.listFiles(plugin, connection, '/dev/null', 'prefix', 0, ctx)
    assert.deepEqual(res, [])
    assert.ok(ctx.depthExceeded)
  })

  it('processFile returns filename for non-archive', async function () {
    const ctx = { tmpfiles: [], timeouted: false, encrypted: false, depthExceeded: false }
    const out = await plugin.processFile(plugin, connection, '/dev/null', '', 'file.txt', 0, ctx)
    assert.deepEqual(out, ['file.txt'])
  })
})
