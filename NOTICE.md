# Notices

Graphics is an independent project and is not affiliated with or endorsed by
tldraw, Inc.

The runtime package does not include the tldraw SDK or tldraw Offline. It writes
the documented `.tldr` JSON interchange format so that users can import a
diagram into compatible tldraw software. The development test suite optionally
uses the upstream `tldraw` package to check compatibility; that package remains
under the [tldraw license](https://tldraw.dev/community/license).

The optional `graphics desktop install` command downloads an unmodified installer
from the official
[`tldraw/tldraw-offline`](https://github.com/tldraw/tldraw-offline) GitHub
release and verifies the SHA-256 digest published by GitHub. tldraw Offline is
not open source and remains subject to its own terms.

tldraw and its associated marks are trademarks of tldraw, Inc.

Raster output uses
[`@resvg/resvg-js`](https://github.com/yisibl/resvg-js), distributed under the
Mozilla Public License 2.0. It is installed as a separate runtime dependency
and is not relicensed by this project.
