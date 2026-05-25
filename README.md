# haraka-plugin-attachment

[![Build Status][ci-img]][ci-url]
[![Code Climate][clim-img]][clim-url]

This plugin allows you to reject messages based on Content-Type anywhere in the MIME tree (the body and every nested part are walked) or on the filename of any attachment, including filenames inside expanded archives.

## Limitations

The `ctype` regex rules are advisory: they match against the `Content-Type` headers the sender supplied, and a sender can lie. No magic-byte / file-signature inspection is performed. For hard blocking, prefer `disallowed_extensions` and the `attachment.filename.regex` / `attachment.archive.filename.regex` lists, which match on the actual filenames (including filenames discovered inside archives).

Encrypted archives that contain encrypted sub-archives cannot be expanded and will cause the plugin to reject the message.

## Requirements

To check filenames inside archive files the npm module `tmp` is required and the `bsdtar` binary must be available.

If either `tmp` or `bsdtar` are unavailable then the plugin will not expand archives.

## Logging

At INFO level logging this plugin will output the filename and type of each attached file along with an MD5 checksum of the contents. The MD5 checksum is useful to check against www.virustotal.com

## Configuration

- attachment.ini
  - default settings shown
  * timeout=30

    Timeout in seconds before the plugin will abort.

  * disallowed_extensions=exe,com,pif,bat,scr,vbs,cmd,cpl,dll

    File extensions that should be rejected when detected.

    [archive]

  * max_depth=5

    Maximum number of archive levels unpacked, counting the outermost
    archive as level 0. With `max_depth=5`, archives at depths 0..4 are
    unpacked and a 6th nested archive is rejected.

  * max_total_bytes=104857600

    Maximum total decompressed size, in bytes, summed across every
    archive expanded for a single message. Default 100 MiB. When the
    running total exceeds this budget the message is rejected.

  * max_total_entries=1000

    Maximum number of entries (files + directories) listed across every
    archive expanded for a single message. Default 1000. When the running
    total exceeds this budget the message is rejected.

    [archive]

  * extensions=zip,tar,tgz,taz,z,gz,rar,7z

    File extensions that should be treated as archives.
    This can be any file type supported by bsdtar.

- attachment.filename.regex

  This file contains a list of regular expressions, one per line that
  will be tested against each filename found within a message.
  The first regexp to match will cause the message to be rejected.
  Any invalid regexps will be detected, reported and skipped.

- attachment.archive.filename.regex

  This file contains a list of regular expressions, one per line that
  will be tested against each filename found within an archive file.
  The first regexp to match will cause the message to be rejected.
  Any invalid regexps will be detected, reported and skipped.

- attachment.ctype.regex

  This file contains a list of regular expressions, one per line that
  will be tested against each MIME Content-Type header in the message.
  The first regexp to match will cause the message to be rejected.
  Any invalid regexps will be detected, reported and skipped.

<!-- leave these buried at the bottom of the document -->

[ci-img]: https://github.com/haraka/haraka-plugin-attachment/actions/workflows/ci.yml/badge.svg
[ci-url]: https://github.com/haraka/haraka-plugin-attachment/actions/workflows/ci.yml
[clim-img]: https://codeclimate.com/github/haraka/haraka-plugin-attachment/badges/gpa.svg
[clim-url]: https://codeclimate.com/github/haraka/haraka-plugin-attachment
