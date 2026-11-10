# Third-party notices

Mergelane is MIT-licensed (see `LICENSE`). It includes or derives from the software below. This file is
copied into the app bundle at `Mergelane.app/Contents/Resources/THIRD-PARTY-NOTICES.md`.

Sections are added as each component lands. Dependency licences for the Electron app and the Go daemon
are listed in their own sections once those components are imported.

## Upstream projects

### Plexo

- Source: https://github.com/anmolkapil/plexo (commit `2e44a2f3e9dbe92ccc5ae8778e4175f889d624d3`)
- Used for: the Electron app shell, download engine, torrent support, scheduler, limits, browser extension,
  end-to-end tests and macOS packaging (`app/`, `extension/`).

```text
MIT License

Copyright (c) 2026 Anmol Kapil

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Net Merge

- Source: https://github.com/rohit267/net-merge (commit `2b333a3ad820996ba337588adfa8f7259a45baec`)
- Used for: the Go link-merging engine in `daemon/`: utun capture, tun2socks/gVisor stack, balancer,
  scheduler, probes, adapter discovery and per-link limits.

```text
MIT License

Copyright (c) 2026 Rohit Mahto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Awesome Downloader

- Source: https://github.com/Ahmadkhattak1/awesome-downloader (commit `d99dbe0e9edfec1c07bbe735e1a1990323d919bf`)
- Used for: ideas and logic for media support (HLS, YouTube SABR, FFmpeg muxing, media detection in the
  browser extension), from Phase 2. No code from it is included yet.

```text
MIT License

Copyright (c) 2026 Awesome Downloader contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Separately shipped executables (from Phase 2)

FFmpeg (GPL) and yt-dlp (Unlicense) will ship as separate executables inside the app bundle. They are
fetched at build time with pinned SHA-256 checksums and are never committed to this repository. Their licence
texts and the matching source offer will be added here and to the bundle when they are introduced.
