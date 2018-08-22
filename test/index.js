'use strict';

process.env.NODE_ENV = 'test';

const assert   = require('assert');
const fixtures = require('haraka-test-fixtures');

const attach = new fixtures.plugin('index');
// console.log(attach);

describe('find_bsdtar_path', function () {
    it('finds the bsdtar binary', function (done) {
        attach.find_bsdtar_path((err, dir) => {
            assert.ifError(err);
            // fails on Travis
            if (dir) {
                assert.ok(dir);
            }
            else {
                console.error('test error: unable to find bsdtar');
            }
            done();
        });
    })
})

describe('register', function () {
    it('is a function', function (done) {
        assert.equal('function', typeof attach.register);
        done();
    });

    it('runs', function (done) {
        attach.register();
        // console.log(attach.cfg);
        done();
    });

    it('loads the config', function (done) {
        attach.register();
        // console.log(attach.cfg.archive);
        // assert.deepEqual(attach.cfg.main, {});
        // assert.deepEqual(attach.cfg.filename, { 'resume.zip': undefined });
        assert.deepEqual(attach.cfg, {
            main: {
                "disallowed_extensions": "ade,adp,bat,chm,cmd,com,cpl,exe,hta,ins,isp,jar,jse,lib,lnk,mde,msc,msp,mst,pif,scr,sct,shb,sys,vb,vbe,vbs,vxd,wsc,wsf,wsh,dll,zip",
                timeout: 30
            },
            timeout: 30000,
            archive: {
                max_depth: 10,
                exts: {
                    'zip': true,
                    'tar': true,
                    'tgz': true,
                    'taz': true,
                    'z':   true,
                    'gz':  true,
                    'rar': true,
                    '7z':  true
                }
            } });
        done();
    });
})

describe('config', function () {
    it('has archive section', function (done) {
        attach.register();
        // console.log(attach.cfg);
        assert.equal(attach.cfg.archive.max_depth, 10);
        assert.ok(attach.cfg.archive.exts)
        done();
    });
})

describe('options_to_object', function () {
    it('converts string to object', function (done) {
        const expected = {'gz': true, 'zip': true};
        assert.deepEqual(expected, attach.options_to_object('gz zip'));
        assert.deepEqual(expected, attach.options_to_object('gz,zip'));
        assert.deepEqual(expected, attach.options_to_object(' gz , zip '));
        done();
    });
})

describe('load_dissallowed_extns', function () {
    it('loads comma separated options', function (done) {
        attach.cfg = { main: { disallowed_extensions: 'exe,scr' } };
        attach.load_dissallowed_extns();

        assert.ok(attach.re.bad_extn);
        assert.ok(attach.re.bad_extn.test('bad.scr'));
        done();
    });

    it('loads space separated options', function (done) {
        attach.cfg = { main: { disallowed_extensions: 'dll tnef' } };
        attach.load_dissallowed_extns();
        assert.ok(attach.re.bad_extn);
        assert.ok(attach.re.bad_extn.test('bad.dll'));
        done();
    });
})

describe('file_extension', function () {
    it('returns a file extension from a filename', function (done) {
        assert.equal('ext', attach.file_extension('file.ext'));
        done();
    })

    it('returns empty string for no extension', function (done) {
        assert.equal('', attach.file_extension('file'));
        done();
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
    it('loads regex lines from file, compiles to array', function (done) {

        attach.load_n_compile_re('test', 'attachment.filename.regex');
        assert.ok(attach.re.test);
        assert.ok(attach.re.test[0].test('foo.exe'));

        done();
    })
})

describe('check_items_against_regexps', function () {
    it('positive', function (done) {
        attach.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(attach.check_items_against_regexps(['file.exe'], attach.re.test));
        assert.ok(attach.check_items_against_regexps(['fine.pdf','awful.exe'], attach.re.test));

        done();
    })

    it('negative', function (done) {
        attach.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(!attach.check_items_against_regexps(['file.png'], attach.re.test));
        assert.ok(!attach.check_items_against_regexps(['fine.pdf','godiva.chocolate'], attach.re.test));

        done();
    })
})

describe('has_archive_extension', function () {
    it('returns true for zip', function (done) {
        attach.load_attachment_ini();
        // console.log(attach.cfg.archive);
        assert.equal(true, attach.has_archive_extension('.zip'));
        assert.equal(true, attach.has_archive_extension('zip'));
        done();
    })
})
