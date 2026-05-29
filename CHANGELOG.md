# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/).

### Unreleased

- test: refactored against test-utils 1.7.0
- test: refactored against test-fixtures 1.7.0

### [1.2.1] - 2026-05-24

- change: test runner is now node:test
- fix(security): cap cumulative decompressed bytes, default 100 MiB
- fix(security): cap cumulative entry count, default 1000
- fix: `check_attachments` walks the full MIME tree so `ctype` rules apply to deeply nested multiparts
- fix: nesting depth now increments once per nested archive (was twice per level)
- doc(README): full-MIME coverage, advisory nature of `ctype` rules, `max_depth` semantics, and new options

### [1.2.0] - 2026-03-18

- chore: refactor unarchive_recursive into 6 fns
- chore: refactor unarchive_recursive as async
- chore: refactor find_bsdtar_path as async
- test: added wait_for_attachment_hooks
- chore: add `node:` prefixes to builtins
- chore: replace `plugin` with `this`
- chore: refactors for brevity and clarity
- chore: use modern `for` loops
- chore: fixed typo in load_dissallowed_extns
- style: prettier, remove line endings
- remove done callbacks in synchronous tests (#44)

### [1.1.5] - 2025-04-02

- fix: typo prevented unarchive zip from throwing errors #42

### [1.1.4] - 2025-01-26

- prettier: move config into package.json

### [1.1.3] - 2025-01-15

- deps(eslint): upgrade to v9
- deps(all): bump to latest

### [1.1.2] - 2024-04-11

- deps: add ^ to required versions
- doc: add CONTRIBUTORS

### [1.1.1] - 2024-04-08

- dep: eslint-plugin-haraka -> @haraka/eslint-config
- lint: remove duplicate / stale rules from .eslintrc
- populate `[files]` in package.json. Delete .npmignore.
- doc: Changes -> CHANGELOG
- doc(CHANGELOG): fixed broken release link
- prettier

### [1.1.0] - 2024-03-20

- chore: bump version deps, and pin them
- fix: minor debug logging issue #32
- fix: restored missing function call #31

### [1.0.7] - 2022-06-16

- import fresh from Haraka
- convert tests to mocha

### 1.0.6 - Dec 22, 2021

- Fix issue with nested archives not getting counted, #26
- replace travis & appveyor with GHA

### 1.0.5 - Aug 21, 2018

- more tests
- update attachment.ini to reflect newer syntax
- fix a cfg path issue
- remove leading dot from file_ext

### 1.0.4 - Aug 21, 2018

- finished converting tests to mocha, tests work again. Yay.
- es6 updates
- backported changes from haraka/plugins/attachment.js

[1.0.6]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.0.6
[1.0.7]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.0.7
[1.1.0]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.0
[1.1.1]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.1
[1.1.2]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.2
[1.1.3]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.3
[1.1.4]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.4
[1.1.5]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.1.5
[1.2.0]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.2.0
[1.2.1]: https://github.com/haraka/haraka-plugin-attachment/releases/tag/v1.2.1
