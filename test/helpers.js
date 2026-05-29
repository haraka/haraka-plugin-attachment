'use strict'

const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { describe, it, beforeEach } = require('node:test')

const { makeConnection, makePlugin } = require('haraka-test-fixtures')

describe('internal helper functions', () => {
  let plugin, connection
  beforeEach(() => {
    plugin = makePlugin('attachment', { register: false })
    // ensure tmp module is available for createTmp
    plugin.load_tmp_module()

    plugin.cfg = { timeout: 100, archive: { exts: { zip: true }, max_depth: 5 } }

    connection = makeConnection({ withTxn: true })
    connection.logdebug = () => {}
    connection.loginfo = () => {}
  })

  it('createTmp creates a temp file and returns fd/name', async () => {
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

  it('timedOutSpawn resolves output and detects timeouts', async () => {
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

  it('deleteTempFiles closes and removes temp files', (t, done) => {
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

  it('listFiles honors max depth and sets depthExceeded', async () => {
    plugin.cfg.archive.max_depth = 0
    const ctx = { tmpfiles: [], timeouted: false, encrypted: false, depthExceeded: false }
    const res = await plugin.listFiles(plugin, connection, '/dev/null', 'prefix', 0, ctx)
    assert.deepEqual(res, [])
    assert.ok(ctx.depthExceeded)
  })

  it('processFile returns filename for non-archive', async () => {
    const ctx = { tmpfiles: [], timeouted: false, encrypted: false, depthExceeded: false }
    const out = await plugin.processFile(plugin, connection, '/dev/null', '', 'file.txt', 0, ctx)
    assert.deepEqual(out, ['file.txt'])
  })

  // Audit C3: nesting depth should increment exactly once per nested
  // archive (not twice via the listFiles→processFile cycle).
  it('listFiles → processFile preserves caller depth (no double-increment)', async () => {
    plugin.cfg.archive.max_depth = 5
    const ctx = {
      tmpfiles: [],
      timeouted: false,
      encrypted: false,
      depthExceeded: false,
    }
    // Stub the archive-shelling helpers so we don't need real bsdtar:
    // a single fake entry, then processFile reports the depth it saw.
    const depthsSeen = []
    plugin.listArchive = async () => ['inner.txt']
    plugin.processFile = async (_p, _c, _in, _pre, _file, depth) => {
      depthsSeen.push(depth)
      return []
    }
    await plugin.listFiles(plugin, connection, '/dev/null', '', 3, ctx)
    assert.deepEqual(depthsSeen, [3], `expected processFile depth=3, got ${depthsSeen}`)
  })

  // Audit S1: cumulative entry count across every nested archive must
  // be bounded; once exceeded, listFiles stops recursing.
  it('listFiles aborts when totalEntries crosses max_total_entries', async () => {
    plugin.cfg.archive.max_depth = 5
    plugin.cfg.archive.max_total_entries = 2
    const ctx = {
      tmpfiles: [],
      timeouted: false,
      encrypted: false,
      depthExceeded: false,
      bytesExceeded: false,
      entriesExceeded: false,
      totalBytes: 0,
      totalEntries: 0,
    }
    plugin.listArchive = async () => ['a', 'b', 'c', 'd']
    plugin.processFile = async () => []
    await plugin.listFiles(plugin, connection, '/dev/null', '', 0, ctx)
    assert.ok(ctx.entriesExceeded, 'entriesExceeded should be set')
    assert.equal(ctx.totalEntries, 4)
  })
})
