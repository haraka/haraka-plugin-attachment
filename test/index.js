'use strict';

const assert = require('assert')
const fixtures = require('haraka-test-fixtures');
const path = require('path');

const attach = new fixtures.plugin('index');
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

describe('options_to_object', function () {
    it('converts string to object', function () {
        const expected = {'gz': true, 'zip': true};
        assert.deepEqual(expected, attach.options_to_object('gz zip'));
        assert.deepEqual(expected, attach.options_to_object('gz,zip'));
        assert.deepEqual(expected, attach.options_to_object(' gz , zip '));
    })
})

describe('load_dissallowed_extns', function () {
    it('loads comma separated options', function () {
        attach.cfg = { main: { disallowed_extensions: 'exe,scr' } };
        attach.load_dissallowed_extns();

        assert.ok(attach.re.bad_extn);
        assert.ok(attach.re.bad_extn.test('bad.scr'));
    })

    it('loads space separated options', function () {
        attach.cfg = { main: { disallowed_extensions: 'dll tnef' } };
        attach.load_dissallowed_extns();
        assert.ok(attach.re.bad_extn);
        assert.ok(attach.re.bad_extn.test('bad.dll'));
    })
})

describe('disallowed_extensions', function () {
    it('blocks filename extensions in attachment_files', function (done) {

        attach.cfg = { main: { disallowed_extensions: 'exe;scr' } };
        attach.load_dissallowed_extns();

        const connection = fixtures.connection.createConnection();
        connection.init_transaction();
        const txn = connection.transaction;
        txn.notes.attachment = {};

        txn.notes.attachment.files = ['naughty.exe'];
        assert.equal('exe', attach.disallowed_extensions(txn));

        txn.notes.attachment.files = ['good.pdf', 'naughty.exe'];
        assert.equal('exe', attach.disallowed_extensions(txn));
        done();
    })

    it('blocks filename extensions in archive_files', function (done) {

        attach.cfg = { main: { disallowed_extensions: 'dll tnef' } };
        attach.load_dissallowed_extns();

        const connection = fixtures.connection.createConnection();
        connection.init_transaction();
        const txn = connection.transaction;
        txn.notes.attachment = {};

        txn.notes.attachment.archive_files = ['icky.tnef'];
        assert.equal('tnef', attach.disallowed_extensions(txn));

        txn.notes.attachment.archive_files = ['good.pdf', 'naughty.dll'];
        assert.equal('dll', attach.disallowed_extensions(txn));

        txn.notes.attachment.archive_files = ['good.pdf', 'better.png'];
        assert.equal(false, attach.disallowed_extensions(txn));

        done();
    })
})

describe('load_n_compile_re', function () {
    it('loads regex lines from file, compiles to array', function () {
        attach.load_n_compile_re('test', 'attachment.filename.regex');
        assert.ok(attach.re.test);
        assert.ok(attach.re.test[0].test('foo.exe'));
    })
})

describe('check_items_against_regexps', function () {
    it('positive', function () {
        attach.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(attach.check_items_against_regexps(['file.exe'], attach.re.test));
        assert.ok(attach.check_items_against_regexps(['fine.pdf','awful.exe'], attach.re.test));
    })

    it('negative', function () {
        attach.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(!attach.check_items_against_regexps(['file.png'], attach.re.test));
        assert.ok(!attach.check_items_against_regexps(['fine.pdf','godiva.chocolate'], attach.re.test));
    })
})

describe('isArchive', function () {
    it('zip', function () {
        attach.load_attachment_ini();
        // console.log(attach.cfg.archive);
        assert.equal(true, attach.isArchive('.zip'));
        assert.equal(true, attach.isArchive('zip'));
    })

    it('png', function () {
        attach.load_attachment_ini();
        assert.equal(false, attach.isArchive('.png'));
        assert.equal(false, attach.isArchive('png'));
    })
})

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
            assert.equal(files?.length, 1);
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
