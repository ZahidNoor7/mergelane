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

## Fonts

The app and its browser extension bundle these fonts (`app/src/renderer/src/assets/fonts/`, with each licence text
beside its font and provenance in that folder's `README.md`). Both are under the SIL Open Font License 1.1.

### Archivo

From google/fonts, `ofl/archivo/`, commit `95f4904fc8bcf26d3420fe315560c96417c6dec7`. Designer: Omnibus-Type.

```
Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### Fragment Mono

From google/fonts, `ofl/fragmentmono/`, commit `8f6cd0c1cdf938a8a31e246d8a9ba09b5f6cc830`. Designers: Wei Huang and
URW Design Studio.

```
Copyright 2022 The Fragment-Mono Project Authors (https://github.com/weiweihuanghuang/fragment-mono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
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

### On Windows (W3)

The Windows builds ship the same versions, for x64 and arm64, from `scripts/media-tools/tools-windows-x64.json` and
`tools-windows-arm64.json`, next to `Mergelane.exe` in the install folder's `resources\`:

- **yt-dlp:** the official unpacked Windows builds, `yt-dlp_win.zip` (x64, SHA-256
  `fd51b212cf8380c7a52ee08c0d6be7f3c59b2f2c832eaf7b45acfae6eab57419`) and `yt-dlp_win_arm64.zip` (arm64, SHA-256
  `5eaa4c61f3c09189f3a551bf1855c13aad61fb865cc33f06012a6c2dbe287a45`), shipped unchanged as the folder `yt-dlp\`.
  Their own list of bundled components, which differs from the macOS build's (Microsoft's Visual C++ runtime among
  them), is `licenses/yt-dlp/THIRD_PARTY_LICENSES.txt` in the Windows app (`licenses/yt-dlp-windows/` here).
- **FFmpeg:** built by Mergelane from the same source release with `scripts/media-tools/build-ffmpeg-windows.sh`: the
  same configuration as on macOS, cross-compiled with llvm-mingw 20261020 (the compiler; nothing of it ships beyond
  the code every program gets from its compiler), and with **zlib 1.3.2** (https://github.com/madler/zlib, zlib
  licence, Copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler) built from its source release (SHA-256
  `bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16`) and linked in. LGPL 2.1 or later, as on macOS.
  zlib's licence text ships as `licenses/ffmpeg/zlib-LICENSE.txt` next to FFmpeg's. Its source is attached to the release
  with the Windows build script.
- **Deno:** the official `deno-x86_64-pc-windows-msvc.zip` (program SHA-256
  `924397800533d3eb0ed0c889b20ad70e18b970d93acd8135bc043f425e528266`) and `deno-aarch64-pc-windows-msvc.zip` (program
  SHA-256 `40d161bc35657cc7432a2e3832290922939cd63fddd29f66db2261d291e42478`), shipped as `deno.exe`, with the same
  licence and notices as on macOS.

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
- Built into it: code by others, under their own licences: V8 and the C and C++ libraries compiled into it (ICU,
  Abseil, LLVM's libc++, libc++abi, libunwind and libc, fast_float, simdutf, Highway, Dragonbox, FP16, PartitionAlloc),
  TypeScript 6.0.3, code ported from Node.js 26.5.1, and the Rust crates in Deno's `Cargo.lock`. Their notices and
  licence texts are in `licenses/deno/THIRD-PARTY-NOTICES.txt`, next to Deno's licence in the app bundle. Deno
  publishes no such list, so Mergelane generates it from pinned official sources with
  `scripts/media-tools/deno-notices.mjs` (`docs/MEDIA-TOOLS.md`, "Deno's bundled components").

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

- Source: https://github.com/denoland/deno/releases/download/v2.9.8/deno_src.tar.gz.
