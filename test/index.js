'use strict';

process.env.NODE_ENV = 'test';

var assert   = require('assert');
var fixtures = require('haraka-test-fixtures');
// var config   = require('haraka-config');
// console.log(config);

var attach = new fixtures.plugin('index');
// attach.config = config;
// console.log(attach);

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
        console.log(attach.cfg.archive);
        // assert.deepEqual(attach.cfg.main, {});
        // assert.deepEqual(attach.cfg.filename, { 'resume.zip': undefined });
        assert.deepEqual(attach.cfg, {
            main: {
                archive_max_depth: 10,
                archive_extns: '.zip,.tar,.tgz,.taz,.z,.gz,.rar,.7z',
                timeout: 30
            },
            timeout: 30000,
            archive: {
                max_depth: 10,
                exts: {
                    '.zip': true,
                    '.tar': true,
                    '.tgz': true,
                    '.taz': true,
                    '.z': true,
                    '.gz': true,
                    '.rar': true,
                    '.7z': true
                }
            } });
        done();
    });
});

describe('config', function () {
    // it('has archive section', function (done) {
    //     attach.register();
    //     // console.log(attach);
    //     // assert.ok(attach.cfg.archive.max_depth);
    //     // assert.ok(attach.cfg.archive.extensions)
    //     done();
    // });
});
/*
describe('options_to_object', function () {
    it('converts string to object', function (done) {
        var expected = {'.gz': true, '.zip': true};
        assert.deepEqual(expected, attach.options_to_object('gz zip'));
        assert.deepEqual(expected, attach.options_to_object('gz,zip'));
        assert.deepEqual(expected, attach.options_to_object(' gz , zip '));
        done();
    });
});

describe('load_disallowed_extensions', function () {
    it('loads comma separated options', function (done) {
        attach.cfg = { main: { bad_filename_extensions: 'exe,scr' } };
        attach.load_disallowed_extensions();

        assert.ok(assert.re.bad_extn);
        assert.ok(assert.re.bad_extn.test('bad.scr'));
        done();
    });

    it('loads space separated options', function (done) {
        attach.cfg = { main: { bad_filename_extensions: 'dll tnef' } };
        attach.load_disallowed_extensions();
        assert.ok(assert.re.bad_extn);
        assert.ok(assert.re.bad_extn.test('bad.dll'));
        done();
    });
});
*/

/*

var _set_up = function (done) {
    this.connection = Connection.createConnection();
    this.connection.transaction = stub;
    this.connection.transaction.results = new ResultStore(assert);
    this.connection.transaction.notes = {};
    done();
};



exports.dissallowed_extns = {
    setUp : _set_up,
    'attachment_files': function (test) {
        test.expect(2);
        assert.cfg = { main: { disallowed_extensions: 'exe;scr' } };
        assert.load_dissallowed_extns();

        var txn = this.connection.transaction;
        txn.notes.attachment_files = ['naughty.exe'];
        test.equal('exe', assert.disallowed_extensions(txn));

        txn.notes.attachment_files = ['good.pdf', 'naughty.exe'];
        test.equal('exe', assert.disallowed_extensions(txn));
        done();
    },
    'attachment_archive_files': function (test) {
        test.expect(3);
        assert.cfg = { main: { disallowed_extensions: 'dll tnef' } };
        assert.load_dissallowed_extns();

        var txn = this.connection.transaction;
        txn.notes.attachment_archive_files = ['icky.tnef'];
        test.equal('tnef', assert.disallowed_extensions(txn));

        txn.notes.attachment_archive_files = ['good.pdf', 'naughty.dll'];
        test.equal('dll', assert.disallowed_extensions(txn));

        txn.notes.attachment_archive_files = ['good.pdf', 'better.png'];
        test.equal(false, assert.disallowed_extensions(txn));
        done();
    },
};

// exports.load_n_compile_re = {
//     setUp : _set_up,
//     'loads regex lines from file, compiles to array': function (test) {
//         test.expect(2);

//         assert.load_n_compile_re('test', 'attachment.filename.regex');
//         assert.ok(assert.re.test);
//         assert.ok(assert.re.test[0].test('foo.exe'));

//         done();
//     },
// };

exports.check_items_against_regexps = {
    setUp : _set_up,
    'positive': function (test) {
        test.expect(2);
        assert.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(assert.check_items_against_regexps(
                    ['file.exe'], assert.re.test));
        assert.ok(assert.check_items_against_regexps(
                    ['fine.pdf','awful.exe'], assert.re.test));

        done();
    },
    'negative': function (test) {
        test.expect(2);
        assert.load_n_compile_re('test', 'attachment.filename.regex');

        assert.ok(!assert.check_items_against_regexps(
                    ['file.png'], assert.re.test));
        assert.ok(!assert.check_items_against_regexps(
                    ['fine.pdf','godiva.chocolate'], assert.re.test));

        done();
    },
};
*/