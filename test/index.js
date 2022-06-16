'use strict';

const assert = require('assert')
const fixtures = require('haraka-test-fixtures');
const path = require('path');


const Connection   = fixtures.connection;

function _set_up (done) {

    this.plugin = new fixtures.plugin('attachment');
    this.plugin.cfg = {};
    this.plugin.cfg.timeout = 10;

    this.connection = Connection.createConnection();
    this.connection.init_transaction();

    this.connection.logdebug = function (where, message) { if (process.env.DEBUG) console.log(message); };
    this.connection.loginfo = function (where, message) { console.log(message); };

    this.directory = path.resolve(__dirname, 'fixtures');

    // we need find bsdtar
    this.plugin.register();
    this.plugin.hook_init_master(done);
}

describe('unarchive', function () {
    beforeEach(_set_up)

    it('3layers', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/3layer.zip`, '3layer.zip', (e, files) => {
            assert.equal(e, null);
            assert.equal(files.length, 3);

            done()
        });
    })

    it('empty.gz', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/empty.gz`, 'empty.gz', (e, files) => {
            assert.equal(e, null);
            assert.equal(files.length, 0);
            done()
        });
    })

    it('encrypt.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/encrypt.zip`, 'encrypt.zip', (e, files) => {
            // we see files list in encrypted zip, but we can't extract so no error here
            assert.equal(e, null);
            assert.equal(files.length, 1);
            done()
        });
    })

    it('encrypt-recursive.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/encrypt-recursive.zip`, 'encrypt-recursive.zip', (e, files) => {
            // we can't extract encrypted file in encrypted zip so error here
            assert.equal(true, e.message.includes('encrypted'));
            assert.equal(files.length, 1);
            done()
        });
    })

    it('gz-in-zip.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()

        this.plugin.unarchive_recursive(this.connection, `${this.directory}/gz-in-zip.zip`, 'gz-in-zip.zip', (e, files) => {
            // gz is not listable in bsdtar
            assert.equal(e, null);
            assert.equal(files.length, 1);
            done()
        });
    })

    it('invalid.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/invalid.zip`, 'invalid.zip', (e, files) => {
            // invalid zip is assumed to be just file, so error of bsdtar is ignored
            assert.equal(e, null);
            assert.equal(files.length, 0);
            done()
        });
    })

    it('invalid-in-valid.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/invalid-in-valid.zip`, 'invalid-in-valid.zip', (e, files) => {
            assert.equal(e, null);
            assert.equal(files.length, 1);
            done()
        });
    })

    it('password.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/password.zip`, 'password.zip', (e, files) => {
            // we see files list in encrypted zip, but we can't extract so no error here
            assert.equal(e, null);
            assert.equal(files.length, 1);
            done()
        });
    })

    it('valid.zip', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/valid.zip`, 'valid.zip', (e, files) => {
            assert.equal(e, null);
            assert.equal(files.length, 1);
            done()
        });
    })

    it('timeout', function (done) {
        if (!this.plugin.bsdtar_path) return done()
        this.plugin.cfg.timeout = 0;
        this.plugin.unarchive_recursive(this.connection, `${this.directory}/encrypt-recursive.zip`, 'encrypt-recursive.zip', (e, files) => {
            assert.ok(true, e.message.includes('timeout'));
            assert.equal(files.length, 0);
            done()
        });
    })
})
