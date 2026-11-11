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

## Separately shipped executables

Mergelane runs these programs as separate executables. They keep their own licences and are not part of Mergelane's
MIT-licensed code.

- They are downloaded (FFmpeg: built from its source release) at build time by `scripts/media-tools/fetch.mjs`,
  checked against the SHA-256 checksums pinned in `scripts/media-tools/tools.json`, and never committed to this
  repository.
- Their licence texts are in the app bundle under `Contents/Resources/licenses/`.
- Every Mergelane release on GitHub has the source code of yt-dlp and FFmpeg attached, exactly the archives these
  programs were built from, with FFmpeg's build script (ADR-0027).
- See `docs/MEDIA-TOOLS.md`.

### yt-dlp 2026.10.26

- Program: the official unpacked macOS build, `yt-dlp_macos.zip` from
  https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26 (SHA-256
  `20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1`), shipped as the folder `Contents/Resources/yt-dlp/`:
  the program `yt-dlp_macos` and its `_internal` files. The three copies the zip holds in place of the links inside
  `_internal/Python.framework` are turned back into those links; nothing else is changed.
- Licence:
  - yt-dlp's own code is released under the Unlicense.
  - This executable bundles Python and other third-party components, so as a whole it is licensed under the GNU
    General Public License, version 3 or later (yt-dlp README, "Licensing").
  - Texts: `licenses/yt-dlp/LICENSE`, `licenses/yt-dlp/THIRD_PARTY_LICENSES.txt`, `licenses/yt-dlp/GPL-3.0.txt`.
- Source: attached to every Mergelane release as `yt-dlp-2026.10.26-source.tar.gz`, the same file as
  https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.tar.gz
  (SHA-256 `21f942d258d25cc4e60b4982a25c423460f0bebb835f38e6dfd1fcb140087f95`). Sources of the bundled components are
  available from the projects listed in `THIRD_PARTY_LICENSES.txt`.

### FFmpeg 9.0.2

- Program: built by Mergelane from FFmpeg's source release, https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
  (SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`, signed by the FFmpeg release signing
  key `FCF986EA15E6E293A5644F10B4322F04D67658D8`), with `scripts/media-tools/build-ffmpeg.sh`; shipped as
  `Contents/Resources/ffmpeg`. FFmpeg's source is not modified. The build only joins and rewraps media: no encoders,
  no network, no devices, and no outside libraries beyond macOS's own.
- Licence:
  - GNU Lesser General Public License, version 2.1 or later: built without `--enable-gpl`, `--enable-version3` or
    `--enable-nonfree`.
  - Texts: `licenses/ffmpeg/LICENSE.md`, `licenses/ffmpeg/COPYING.LGPLv2.1`, from the 9.0.2 source release.
- Source: attached to every Mergelane release as `ffmpeg-9.0.2-source.tar.xz` (the tarball above) and
  `ffmpeg-9.0.2-build-ffmpeg.sh` (the build script).
- This software is based in part on the work of the Independent JPEG Group. (FFmpeg's `LICENSE.md` asks for this
  credit for three files it takes from libjpeg; they are not modified.)

### Deno 2.9.8

- Program: the official `deno-aarch64-apple-darwin.zip` release, https://github.com/denoland/deno/releases/tag/v2.9.8
  (zip SHA-256 `9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e`, program SHA-256
  `d1e99265e5e6ee096c5780d88ff7d3e6cfdf33b1953a118b4889cab8ca6980ba`), shipped as `Contents/Resources/deno`. yt-dlp
  runs it to solve YouTube's player challenges; Mergelane never runs it otherwise.
- Licence: MIT. Text: `licenses/deno/LICENSE.md`.

```text
MIT License

Copyright 2018-2026 the Deno authors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

- The program includes V8 (BSD-3-Clause), TypeScript (Apache-2.0) and Rust libraries under their own permissive
  licences; their notices are not yet collected here (see `docs/MEDIA-TOOLS.md`, open questions).
- Source: https://github.com/denoland/deno/releases/download/v2.9.8/deno_src.tar.gz.
