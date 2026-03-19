'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fixtures = require('haraka-test-fixtures');

const attach = new fixtures.plugin('index');

function _set_up(done) {
  this.plugin = new fixtures.plugin('attachment');
  this.plugin.cfg = {};
  this.plugin.cfg.timeout = 10;

  this.connection = fixtures.connection.createConnection();
  this.connection.init_transaction();

  this.connection.logdebug = function (where, message) {
    if (process.env.DEBUG) console.log(message);
  };
  this.connection.loginfo = function (where, message) {
    console.log(message);
  };

  this.directory = path.resolve(__dirname, 'fixtures');

  // finds bsdtar
  this.plugin.register();
  this.plugin.hook_init_master(done);
}

describe('options_to_object', function () {
  it('converts string to object', function () {
    const expected = { gz: true, zip: true };
    assert.deepEqual(expected, attach.options_to_object('gz zip'));
    assert.deepEqual(expected, attach.options_to_object('gz,zip'));
    assert.deepEqual(expected, attach.options_to_object(' gz , zip '));
  });
});

describe('options_to_object regression', function () {
  it('should split on all whitespace, not just the first', function () {
    const input = 'zip   gz   rar';
    const result = attach.options_to_object(input);
    assert.deepEqual(result, { zip: true, gz: true, rar: true });
  });
});

describe('load_disallowed_extns', function () {
  it('loads comma separated options', function () {
    attach.cfg = { main: { disallowed_extensions: 'exe,scr' } };
    attach.load_disallowed_extns();

    assert.ok(attach.re.bad_extn);
    assert.ok(attach.re.bad_extn.test('bad.scr'));
  });

  it('loads space separated options', function () {
    attach.cfg = { main: { disallowed_extensions: 'dll tnef' } };
    attach.load_disallowed_extns();
    assert.ok(attach.re.bad_extn);
    assert.ok(attach.re.bad_extn.test('bad.dll'));
  });
});

describe('file_extension', function () {
  it('returns a file extension from a filename', function () {
    assert.equal('ext', attach.file_extension('file.ext'));
  });

  it('returns empty string for no extension', function () {
    assert.equal('', attach.file_extension('file'));
  });
});

describe('disallowed_extensions', function () {
  it('blocks filename extensions in attachment_files', function () {
    attach.cfg = { main: { disallowed_extensions: 'exe;scr' } };
    attach.load_disallowed_extns();

    const connection = fixtures.connection.createConnection();
    connection.init_transaction();
    const txn = connection.transaction;

    txn.notes.attachment_files = ['naughty.exe'];
    assert.equal('exe', attach.disallowed_extensions(txn));

    txn.notes.attachment_files = ['good.pdf', 'naughty.exe'];
    assert.equal('exe', attach.disallowed_extensions(txn));
  });

  it('blocks filename extensions in archive_files', function () {
    attach.cfg = { main: { disallowed_extensions: 'dll tnef' } };
    attach.load_disallowed_extns();

    const connection = fixtures.connection.createConnection();
    connection.init_transaction();
    const txn = connection.transaction;
    txn.notes.attachment = {};

    txn.notes.attachment_archive_files = ['icky.tnef'];
    assert.equal('tnef', attach.disallowed_extensions(txn));

    txn.notes.attachment_archive_files = ['good.pdf', 'naughty.dll'];
    assert.equal('dll', attach.disallowed_extensions(txn));

    txn.notes.attachment_archive_files = ['good.pdf', 'better.png'];
    assert.equal(false, attach.disallowed_extensions(txn));
  });
});

describe('load_n_compile_re', function () {
  it('loads regex lines from file, compiles to array', function () {
    attach.load_n_compile_re('test', 'attachment.filename.regex');
    assert.ok(attach.re.test);
    assert.ok(attach.re.test[0].test('foo.exe'));
  });
});

describe('check_items_against_regexps', function () {
  it('positive', function () {
    attach.load_n_compile_re('test', 'attachment.filename.regex');

    assert.ok(attach.check_items_against_regexps(['file.exe'], attach.re.test));
    assert.ok(
      attach.check_items_against_regexps(['fine.pdf', 'awful.exe'], attach.re.test),
    );
  });

  it('negative', function () {
    attach.load_n_compile_re('test', 'attachment.filename.regex');

    assert.ok(!attach.check_items_against_regexps(['file.png'], attach.re.test));
    assert.ok(
      !attach.check_items_against_regexps(
        ['fine.pdf', 'godiva.chocolate'],
        attach.re.test,
      ),
    );
  });
});

describe('isArchive', function () {
  it('zip', function () {
    attach.load_attachment_ini();
    // console.log(attach.cfg.archive);
    assert.equal(true, attach.isArchive('.zip'));
    assert.equal(true, attach.isArchive('zip'));
  });

  it('png', function () {
    attach.load_attachment_ini();
    assert.equal(false, attach.isArchive('.png'));
    assert.equal(false, attach.isArchive('png'));
  });
});

describe('unarchive_recursive', function () {
  beforeEach(_set_up);

  it('3layers', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/3layer.zip`,
        '3layer.zip',
        (e, files) => {
          assert.equal(e, null);
          assert.equal(files.length, 3);
          resolve();
        },
      );
    });
  });

  it('empty.gz', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/empty.gz`,
        'empty.gz',
        (e, files) => {
          assert.equal(e, null);
          assert.equal(files.length, 0);
          resolve();
        },
      );
    });
  });

  it('encrypt.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/encrypt.zip`,
        'encrypt.zip',
        (e, files) => {
          // we see files list in encrypted zip, but we can't extract so no error here
          assert.equal(e, null);
          assert.equal(files?.length, 1);
          resolve();
        },
      );
    });
  });

  it('encrypt-recursive.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/encrypt-recursive.zip`,
        'encrypt-recursive.zip',
        (e, files) => {
          // we can't extract encrypted file in encrypted zip so error here
          assert.equal(true, e.message.includes('encrypted'));
          assert.equal(files.length, 1);
          resolve();
        },
      );
    });
  });

  it('gz-in-zip.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/gz-in-zip.zip`,
        'gz-in-zip.zip',
        (e, files) => {
          // gz is not listable in bsdtar
          assert.equal(e, null);
          assert.equal(files.length, 1);
          resolve();
        },
      );
    });
  });

  it('invalid.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/invalid.zip`,
        'invalid.zip',
        (e, files) => {
          // invalid zip is assumed to be just file, so error of bsdtar is ignored
          assert.equal(e, null);
          assert.equal(files.length, 0);
          resolve();
        },
      );
    });
  });

  it('invalid-in-valid.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/invalid-in-valid.zip`,
        'invalid-in-valid.zip',
        (e, files) => {
          assert.equal(e, null);
          assert.equal(files.length, 1);
          resolve();
        },
      );
    });
  });

  it('password.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/password.zip`,
        'password.zip',
        (e, files) => {
          // we see files list in encrypted zip, but we can't extract so no error here
          assert.equal(e, null);
          assert.equal(files.length, 1);
          resolve();
        },
      );
    });
  });

  it('valid.zip', async function () {
    if (!this.plugin.bsdtar_path) return;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/valid.zip`,
        'valid.zip',
        (e, files) => {
          assert.equal(e, null);
          assert.equal(files.length, 1);
          resolve();
        },
      );
    });
  });

  it('timeout', async function () {
    if (!this.plugin.bsdtar_path) return;
    this.plugin.cfg.timeout = 0;
    await new Promise((resolve) => {
      this.plugin.unarchive_recursive(
        this.connection,
        `${this.directory}/encrypt-recursive.zip`,
        'encrypt-recursive.zip',
        (e, files) => {
          assert.ok(true, e.message.includes('timeout'));
          assert.equal(files.length, 0);
          resolve();
        },
      );
    });
  });
});

describe('start_attachment', function () {
  beforeEach(_set_up);

  it('finds an message attachment', async function () {
    // const pi = this.plugin
    const txn = this.connection.transaction;

    await new Promise((resolve) => {
      this.plugin.hook_data(function () {
        // console.log(pi)
        const msgPath = path.join(__dirname, 'fixtures', 'haraka-icon-attach.eml');
        // console.log(`msgPath: ${msgPath}`)
        const specimen = fs.readFileSync(msgPath, 'utf8');

        for (const line of specimen.split(/\r?\n/g)) {
          txn.add_data(`${line}\r\n`);
        }

        txn.end_data();
        txn.ensure_body();

        // console.dir(txn.message_stream)
        assert.deepEqual(
          txn.message_stream.idx['Apple-Mail=_65C16661-5FA8-4757-B627-13E55C40C8D7'],
          { start: 5232, end: 6384 },
        );
        resolve();
      }, this.connection);
    });
  });
});
