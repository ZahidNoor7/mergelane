# Media tools: yt-dlp, FFmpeg and Deno

Mergelane uses three outside programs for video:

- **yt-dlp** finds a YouTube video's formats (ADR-0026). Mergelane downloads them itself.
- **FFmpeg** joins separate audio and video tracks, and turns HLS and DASH streams into normal files.
- **Deno** is the JavaScript runtime yt-dlp runs YouTube's player challenges in (see "Deno" below).

CLAUDE.md requires that all of them ship only as separate programs inside the app, fetched (or, for FFmpeg, built)
when the app is built, checked against pinned SHA-256 checksums, and never committed to git. This page says which
exact builds we use, why, and what their licences ask of us.

## In short

| | yt-dlp | FFmpeg |
|---|---|---|
| Version | 2026.10.26 (latest release on 2026-11-10) | 9.0.2 (latest stable FFmpeg, released 2026-09-18) |
| Comes from | yt-dlp's own GitHub release | **Built by Mergelane** from ffmpeg.org's source release (ADR-0028) |
| File | `yt-dlp_macos.zip` (54.2 MB), unpacked into a folder (96 MB, 134 files) | `ffmpeg-9.0.2.tar.xz` (12.0 MB), built into one 4.1 MB program |
| Runs on Apple silicon | Yes: a universal program with an arm64 part | Yes: arm64 only |
| Checksum | The release's `SHA2-256SUMS` | Pinned by us; FFmpeg's GPG signature checked when it was pinned |
| Licence of the program we ship | GPL version 3 or later (yt-dlp's own code is Unlicense) | **LGPL version 2.1 or later** |
| Source on each Mergelane release | `yt-dlp-2026.10.26-source.tar.gz` | `ffmpeg-9.0.2-source.tar.xz` and `ffmpeg-9.0.2-build-ffmpeg.sh` |

To fetch and build them (on an Apple silicon Mac, with Node.js 22 or later, as in CI, and the Xcode command line
tools, which the FFmpeg build needs: clang and make):

```sh
node scripts/media-tools/fetch.mjs            # into app/resources/bin (ignored by git)
node scripts/media-tools/fetch.mjs some/dir   # or anywhere else
```

The pinned list is `scripts/media-tools/tools.json`. The licence texts are committed in
`scripts/media-tools/licenses/`, and the script copies them next to the programs. A full fetch took 80 seconds on the
owner's Mac (2026-11-11), most of it downloads and the FFmpeg build; a second run that finds everything in place takes
a fraction of a second.

## yt-dlp: the unpacked macOS build (ADR-0031)

We use the official release from https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26, the file named
`yt-dlp_macos.zip`: the same program as the single-file `yt-dlp_macos`, as a folder with the program `yt-dlp_macos`
and its `_internal` files (Python, its libraries, and yt-dlp's code).

- **Why the folder, not the single file.** The single file is a PyInstaller "one-file" program: every run unpacks
  itself into a new temporary folder first. On the owner's Mac each run of it took about 24 seconds, and each YouTube
  video costs at least two runs (New download, then one per network as it downloads, ADR-0030). The folder needs no
  unpacking. Measured on 2026-11-11 with `yt-dlp_macos --version`, as installed by `fetch.mjs`:
  - first start after a fresh install: 21.4 s, and 24.7 s after a second fresh install. Almost all of it is waiting
    (0.6 s of CPU): it looks like macOS's one-time check of newly written programs;
  - every start after that: 0.25 to 0.26 s;
  - a copy re-signed ad-hoc with the hardened runtime, as packaging does: 0.32 s the first time, 0.25 s after.
  How long the very first start takes for a user after installing the DMG can only be measured on a packaged build.
- **It runs natively on Apple silicon.** `lipo -archs` on `yt-dlp_macos` reports `x86_64 arm64`, and it prints
  `2026.10.26`.
- **The checksum is the publisher's.** The zip's SHA-256,
  `20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1`, matches its line in the release's
  `SHA2-256SUMS` and GitHub's own digest of the upload (checked 2026-11-11). yt-dlp also signs `SHA2-256SUMS` with GPG;
  that signature was not checked here (see the open questions).
- **One repair: three links.** yt-dlp's build workflow makes the zip with `zip -r` (`.github/workflows/build.yml` at
  the tag), which stores symbolic links as copies. So the zip's `_internal/Python.framework` holds copies where
  PyInstaller made links (`Versions/Current`, and `Python` and `Resources` at the top). electron-builder's signer
  (`@electron/osx-sign`) refuses that framework ("bundle format is ambiguous (could be app or framework)"), so the app
  could not be packaged. `tools.json` lists the three (`links`), and `fetch.mjs` turns each back into its link, only
  when the copy is byte-for-byte identical to what the link points to. Every file keeps its contents; the folder
  shrinks from 124 MB to 96 MB. Re-signed with the hardened runtime as electron-builder does, all 105 Mach-O files in
  it then verify (`codesign --verify --strict`), and the program runs.
- It is ad-hoc signed (no Apple Developer ID). Mergelane re-signs everything in its bundle anyway.

For YouTube, yt-dlp also needs `yt-dlp-ejs` (its challenge-solver scripts) and a JavaScript runtime. Checked on
2026-11-11 against the pinned single-file program, from the same release and the same code:

- **The scripts are built into the program.** Its `--verbose` header lists `yt_dlp_ejs-0.8.0` among its libraries,
  and the README says of `--remote-components`: "This option is currently not needed if you are using an official
  executable". yt-dlp checks the scripts against SHA3-512 hashes kept in its own code
  (`yt_dlp/extractor/youtube/jsc/_builtin/vendor/_info.py`, version 0.8.0), so they are pinned with the program. The
  folder build has them in `_internal/yt_dlp_ejs`.
- **Nothing is fetched at run time.** Mergelane passes `--no-remote-components`; yt-dlp would otherwise only fetch
  scripts from npm or GitHub when told to (`ejs:npm`, `ejs:github`, which are off by default).
- **The runtime is ours.** `--no-js-runtimes --js-runtimes deno:<path>` enables only the bundled Deno (the header
  then reads `JS runtimes: deno-2.9.8`). yt-dlp runs it as `deno run --ext=js --no-code-cache --no-prompt
  --no-remote --no-lock --node-modules-dir=none --no-config --no-npm --cached-only -`
  (`jsc/_builtin/deno.py`).
- The live test (`app/e2e/youtubeLive.spec.ts`) passed with the folder build and our FFmpeg on 2026-11-11.

## FFmpeg: our own minimal build (ADR-0028)

FFmpeg's project publishes source code only. Mergelane builds its FFmpeg from the official source release with
`scripts/media-tools/build-ffmpeg.sh`, which `fetch.mjs` runs after checking the tarball's pinned SHA-256.

**Why our own build.** Mergelane only joins and rewraps media with stream copy (`app/src/main/media/mux`), so it needs
no encoders. The earlier choice, Martin Riedl's static GPL build (ADR-0022), downloads x264 from its `master` branch on
every build without recording the commit, so we could not attach the exact source of the program we would ship
(ADR-0027). The prebuilt macOS builds that were compared (evermeet.cx: Intel only; osxexperts.net: no configure
options published; the ffmpeg-static npm package: an old second-hand build) are recorded in ADR-0022.

**What the build contains** (the configure options in `build-ffmpeg.sh`):

- `--disable-everything`, then only:
  - demuxers `mov` (MP4 and M4A), `mpegts`, `matroska` (MKV and WebM), `aac`, `mp3`, `ac3` and `eac3`, which are the
    formats the mux module whitelists (`INPUT_DEMUXERS` in `run.ts`);
  - muxers `mp4` and `matroska`;
  - parsers for H.264, HEVC, AV1, VP8, VP9, AAC (and LATM), AC-3, MPEG audio, Opus, FLAC and Vorbis;
  - decoders for AAC, AAC LATM, MP3, AC-3, E-AC-3, Opus, FLAC, Vorbis and VP9: stream copy reads a frame or two to
    learn what a container doesn't say. Nothing is ever re-encoded; the build has no encoders at all;
  - bitstream filters `aac_adtstoasc`, `vp9_superframe` and `extract_extradata`;
  - protocols `file` (the media) and `pipe` (the module reads `-progress pipe:1` on standard output; the inputs are
    limited to `file` by `-protocol_whitelist file`).
- `--disable-autodetect --disable-network`, no devices (`--disable-avdevice`), no ffplay or ffprobe, and no outside
  libraries except macOS's own zlib and system frameworks (`otool -L`).
- Not `--enable-gpl`, `--enable-version3` or `--enable-nonfree`. The script fails if the result's `-buildconf` shows
  any of them, or if `ffmpeg -L` does not report the GNU Lesser General Public License.

**What was checked** (2026-11-11, this Mac, FFmpeg 9.0.2):

- The tarball: 12,040,788 bytes, SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`, and
  `gpg --verify` against `ffmpeg-9.0.2.tar.xz.asc` gave "Good signature" from the FFmpeg release signing key
  `FCF986EA15E6E293A5644F10B4322F04D67658D8`, the fingerprint ffmpeg.org's download page publishes. Both are in
  `tools.json` (`signatureUrl`, `signingKey`); the fetch checks the SHA-256, not the signature.
- The program: 4.1 MB, arm64 only, LGPL version 2.1 or later. Two separate builds on this Mac gave the same SHA-256.
- It joined all 52 video and audio combinations tried, identical to Homebrew's full FFmpeg 8.1.2 (H.264, HEVC, VP9 and
  AV1 video with AAC, Opus, MP3, AC-3 and E-AC-3 audio, into MP4 and MKV, and MPEG-TS rewraps).
- The first version of the script had only the `file` protocol, so every join through the app's mux module failed:
  the module asks for `-progress pipe:1` ("Send program-friendly progress information to url", ffmpeg's
  documentation), and FFmpeg answered "Protocol not found". Adding `pipe` fixed it; the module's real-FFmpeg tests
  cover it.
- The test suite runs the app's own joins with it, and checks that it refuses what it should: no encoders, no
  network protocols (http, https, tcp and rtmp are "Protocol not found", and nothing connects), no `lavfi` or
  `avfoundation` input (`app/e2e/mux.spec.ts`).
- It can't make test media (no encoders, no `lavfi`), nor write the `null` output format the tests read files back
  with, so the tests use a second, full FFmpeg for that: Homebrew's (`brew install ffmpeg`), or the one named by
  `MERGELANE_E2E_FIXTURE_FFMPEG`. That one is test-only and never shipped. The FFmpeg under test is
  `MERGELANE_FFMPEG_PATH`, else `app/resources/bin/ffmpeg`, and never Homebrew's (`app/e2e/streamMedia.ts`).

Anything beyond stream copy, such as re-encoding, would need this build to grow.

## Deno: which file and why

yt-dlp needs a JavaScript runtime for YouTube (README, "Dependencies": "A JavaScript runtime/engine like deno
(recommended)"). The app itself can't be it: its `runAsNode` fuse is off (ADR-0016).

| | Deno |
|---|---|
| Version | 2.9.8 (latest stable release on 2026-11-11, published 2026-10-21) |
| Comes from | Deno's own GitHub release, https://github.com/denoland/deno/releases/tag/v2.9.8 |
| File | `deno-aarch64-apple-darwin.zip` (38.8 MB), containing one 81.5 MB program, `deno` |
| Runs on Apple silicon | Yes: arm64 only (`lipo -archs`) |
| Checksums published by the source | Yes: `deno-aarch64-apple-darwin.zip.sha256sum` for the zip, `deno-aarch64-apple-darwin.sha256sum` for the program |
| Licence | MIT |

What was checked on the download (2026-11-11):

- The zip's SHA-256, `9f0bf660393da2eaff044cdc7444cb08c73f235849b61d224d825a194ce7c98e`, matches its `.sha256sum`
  file and GitHub's record of the upload.
- The program's SHA-256, `d1e99265e5e6ee096c5780d88ff7d3e6cfdf33b1953a118b4889cab8ca6980ba`, matches the release's
  `deno-aarch64-apple-darwin.sha256sum`. Both are pinned in `tools.json`.
- It is signed with Deno's Developer ID ("Deno Land Inc. (2H4KBF436B)"), links only macOS's own libraries
  (`otool -L`), and `deno --version` printed `deno 2.9.8 (stable, release, aarch64-apple-darwin)`.
- Re-signed ad-hoc with the hardened runtime and the app's `entitlements.mac.plist` (as electron-builder does), it
  still runs JavaScript with the flags yt-dlp uses: V8 needs the `allow-jit` entitlement, which that file has. The
  packaging test checks this on the real bundle.
- Deno writes caches it can't be told not to into `DENO_DIR` (yt-dlp's code says "Can't avoid analysis cache").
  Mergelane points `DENO_DIR` at a folder of its own for each yt-dlp run and deletes it after, and sets
  `DENO_NO_UPDATE_CHECK` and `DENO_NO_PROMPT` (all from `deno --help`, "Environment variables").

## Licences, in plain words

This is a summary for planning, not legal advice.

### yt-dlp

- yt-dlp's own code is released under the **Unlicense** (essentially public domain): `licenses/yt-dlp/LICENSE`.
- But the macOS program bundles Python and other libraries. yt-dlp's README says: "the PyInstaller-bundled
  executables include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+". On macOS this
  includes, for example, mutagen (GPL-2.0-or-later). The full list is in `licenses/yt-dlp/THIRD_PARTY_LICENSES.txt`
  (some entries there are marked as Linux- or Windows-only).
- So we treat the program we ship as **GPL version 3 or later**: `licenses/yt-dlp/GPL-3.0.txt`. The folder build is the
  same program in another form, so this is unchanged (ADR-0031).

### FFmpeg

- FFmpeg is LGPL version 2.1 or later unless it is configured with `--enable-gpl` or `--enable-version3` (its
  `LICENSE.md`). Ours is configured with neither, and with no outside library that would ask for them, so the program
  we ship is **LGPL version 2.1 or later**, as `ffmpeg -L` reports.
- Texts: `licenses/ffmpeg/LICENSE.md` and `licenses/ffmpeg/COPYING.LGPLv2.1`, both from the verified 9.0.2 tarball.
- The LGPL asks that the program comes with its complete corresponding source, or with equivalent access to it from
  the same place (section 4), and defines that source as "all the source code for all modules it contains, plus any
  associated interface definition files, plus the scripts used to control compilation and installation of the
  library". For us that is exactly two files: the tarball and `build-ffmpeg.sh`. Both are attached to every release.
- FFmpeg's `LICENSE.md` also says three of its files come from libjpeg, and that when only the program (not source)
  is shipped, the documentation must state that "this software is based in part on the work of the Independent JPEG
  Group". We ship the source too, but the sentence is in `THIRD-PARTY-NOTICES.md` anyway.

### Deno

- Deno is released under the **MIT** licence: `licenses/deno/LICENSE.md`, from the `v2.9.8` tag. It asks only that
  the notice ships with the program, which the fetch script and the packaging config do.
- Being MIT, it needs no source offer (ADR-0027), so `tools.json` gives no `sourceSha256` for it and the release
  doesn't attach its source.
- The program also contains code by others under their own licences: V8 and the C and C++ libraries built into it,
  TypeScript, code ported from Node.js, and Rust libraries. Their notices are in
  `licenses/deno/THIRD-PARTY-NOTICES.txt`, which ships next to Deno's licence (see "Deno's bundled components" below).

### Deno's bundled components

Deno's release publishes no list of the third-party code inside the program. Checked on 2026-11-11: the `v2.9.8`
release has only the programs, their checksums, `deno_src.tar.gz` and `lib.deno.d.ts`; the repository at the tag has no
combined notices file (only `LICENSE.md`, `cli/tsc/dts/node/LICENSE`, `cli/tsc/dts/node/undici/LICENSE` and
`ext/webgpu/LICENSE.md`); and `deno --help` lists no command that prints notices.

So `scripts/media-tools/deno-notices.mjs` builds the list from official sources, all pinned in
`scripts/media-tools/deno-notices.json`, into `scripts/media-tools/licenses/deno/THIRD-PARTY-NOTICES.txt` (committed,
about 2.1 MB). `tools.json` lists it among Deno's `licenseFiles`, so the fetch copies it into the app, and the packaging
test checks it is there. The same inputs always give the same file. What it covers:

1. **Rust crates.** Deno's source release (`deno_src.tar.gz`, pinned by its SHA-256) gives `Cargo.lock`: 1,048 packages
   from crates.io and Deno's own 82 workspace crates. Each crates.io package is downloaded from crates.io and checked
   against the SHA-256 in `Cargo.lock`, and its licence, notice and copying files are taken as published: its own, and
   those of code it bundles (for example zlib inside `libz-sys`), outside tests, examples and docs.
   - 926 crates publish their own licence text.
   - 97 don't: their texts come from their repository, at the commit `.cargo_vcs_info.json` says the crate was
     published from (for the swc crates, whose recorded commits are not in swc's repository, swc's `LICENSE` at a
     pinned commit). They are pinned as `crateFallbacks`.
   - 25 have neither a licence file nor one in their repository (or name no repository or commit): the standard text
     of each licence they declare is given, from SPDX's license-list-data v3.29.0 (`spdxTexts`), and they are marked
     "standard text". Their own copyright lines are therefore not in the file.
   - `Cargo.lock` lists the crates of every platform and of Deno's tests and tools, so the list is longer than what the
     macOS program contains.
2. **V8 and what is built into it.** The `v8` crate (rusty_v8 150.4.0) excludes every licence file from its package,
   so they come from rusty_v8's repository at the commit the crate was published from, and from its submodules at the
   commits pinned there: V8 (with `LICENSE.fdlibm`, `LICENSE.strongtalk`, `LICENSE.v8` and V8's own `third_party`
   licences), ICU, Abseil, FP16, LLVM's libc++, libc++abi, libunwind and libc, fast_float, simdutf, Highway, Dragonbox
   and PartitionAlloc (which has no licence file of its own; Chromium's `LICENSE` is given). Submodules used only to
   build (Chromium's build files, clang, jinja2, markupsafe, Chromium's Rust crates, the Windows tools) are left out.
3. **JavaScript and TypeScript in Deno.** TypeScript 6.0.3 (`LICENSE.txt` and `ThirdPartyNoticeText.txt` at its tag),
   Node.js's own licence at 26.5.1 (the version Deno's Node.js layer reports; the part before its list of external
   libraries), the licence files inside Deno's source, and the copyright notices in the comments of the 640 JavaScript
   and TypeScript files under `cli/js`, `cli/tsc`, `ext` and `runtime` (31 distinct notices).

What it does not cover: macOS's own libraries (linked, not included); and code whose authors gave no licence file or
notice in any of these sources. The 25 "standard text" crates are covered by their licence's text but without their
authors' copyright lines.

To regenerate it (about 250 MB of crates are downloaded; `--cache` keeps them between runs, outside the repository):

```sh
node scripts/media-tools/deno-notices.mjs --cache ~/some-scratch-folder/deno-crates
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/deno-notices.mjs' \
  scripts/media-tools/deno-notices.test.mjs
```

### What this means for Mergelane

- **Mergelane stays MIT.** It runs these tools as separate programs and does not link their code into its own. The
  GPL (version 3, section 5) calls this an "aggregate": putting a GPL program in one "does not cause this License to
  apply to the other parts of the aggregate."
- **What we do whenever we hand out a DMG:**
  1. Ship the licence texts with the programs: `fetch.mjs` copies them, electron-builder puts them in
     `Contents/Resources/licenses/`, and the packaging test checks they are there.
  2. Keep the authors' notices, and never present the tools as Mergelane's own work.
  3. Make the matching source code available: every GitHub release has yt-dlp's source tarball, FFmpeg's source
     tarball and FFmpeg's build script attached (ADR-0027, `scripts/media-tools/sources.mjs`, `docs/RELEASING.md`),
     each checked against its pinned SHA-256, and the release notes say so. For the libraries bundled in yt-dlp,
     `THIRD_PARTY_LICENSES.txt` points to the original projects and says the yt-dlp maintainers will provide sources
     on request.

## How the fetch works

`scripts/media-tools/fetch.mjs` uses only Node.js built-ins and the macOS tools `ditto`, `tar`, `lipo` and `bash`.
Each tool in `tools.json` says how it is installed (`install`):

- **`file`** (Deno): one program, `<output>/<name>`. Skipped when that file already has the pinned SHA-256 (only the
  licence texts are refreshed).
- **`folder`** (yt-dlp): an archive whose contents become `<output>/<name>/`; `executable` names the program in it,
  and `links` the copies to turn back into links (see the yt-dlp section).
- **`build`** (FFmpeg): the source tarball at `sourceUrl`, pinned by `sourceSha256`, built by `buildScript`, a script
  next to `tools.json`.

For each one it:

1. checks whether the installed copy is still right: for a file, its SHA-256; for a folder or a build, the stamp in
   `<output>/.stamps/<name>.json` must match the pinned hashes (and the build script's SHA-256, for a build) and the
   hash of what is installed (the program, or every file, link and permission in the folder). If so, nothing is
   downloaded or built;
2. downloads the pinned address, following redirects. Only `https` is allowed (plain `http` only for the local test
   server);
3. checks the download's SHA-256 **before** anything is unpacked, built or made executable. A mismatch stops with both
   values printed, and the download is deleted;
4. for a file, unpacks a zip with `/usr/bin/ditto` (or a tar archive with `/usr/bin/tar`) into an empty temporary
   folder, refuses paths that lead out of it, and checks the program's own SHA-256; for a folder, unpacks it the same
   way and refuses anything in it that is not a file, a folder, or a link that stays inside; for a build, runs
   `/bin/bash <script> <tarball> <out-dir>` (an argument list, no command line for a shell to parse) with its own
   temporary folder as `TMPDIR`, removed afterwards whatever happens; the script must write `<out-dir>/<name>`;
5. checks that `lipo -archs` lists `arm64`;
6. replaces `<output>/licenses/<tool>/` with exactly the tool's licence texts, then installs the program (mode
   0755) or the folder, and writes the stamp.

Any failure exits with code 1 and a message starting `fetch-media-tools:` (a failed build ends with the last lines of
its output), and leaves no half-installed program: whatever was installed before stays as it was.

Tests (no network and no real compile: tiny programs made with `clang`, served from a local web server, and fake
build scripts):

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/fetch.mjs' \
  scripts/media-tools/fetch.test.mjs
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/sources.mjs' \
  scripts/media-tools/sources.test.mjs
```

## Updating a pinned version

Do this in a scratch folder, never in the repository.

- **FFmpeg:** on https://ffmpeg.org/download.html, take the newest release's `ffmpeg-X.Y.Z.tar.xz` and its `.asc`,
  and the release signing key's fingerprint from the page's "Release Verification" section
  (`FCF986EA15E6E293A5644F10B4322F04D67658D8` on 2026-11-11). Import the key (from the page's link) into a
  scratch GPG home and run `gpg --verify ffmpeg-X.Y.Z.tar.xz.asc ffmpeg-X.Y.Z.tar.xz`: it must say "Good signature"
  from that fingerprint. Then:
  1. In `tools.json`, update `version`, `sourceUrl`, `sourceSha256` (`shasum -a 256`), `signatureUrl`, `signingKey`
     if it changed, and the `n<version>` tag in `licenseUrl`.
  2. Replace `licenses/ffmpeg/LICENSE.md` and `COPYING.LGPLv2.1` with the files from the new tarball, and read
     `LICENSE.md` for changes.
  3. Run `bash scripts/media-tools/build-ffmpeg.sh ffmpeg-X.Y.Z.tar.xz out` once by hand. If configure rejects a
     component name, adjust the lists (keep them in step with `app/src/main/media/mux/run.ts`).
  4. Run `node scripts/media-tools/fetch.mjs` and the app's FFmpeg tests: `mux.spec.ts` (which also checks the build
     refuses encoding, the network and devices), `streamTransfer.spec.ts`, `streamDownload.spec.ts`,
     `youtube.spec.ts` and `youtubeDownload.spec.ts`.
- **yt-dlp:** `gh api repos/yt-dlp/yt-dlp/releases/latest`. Download `yt-dlp_macos.zip` and `SHA2-256SUMS` from that
  release, check that `shasum -a 256 yt-dlp_macos.zip` matches its line in `SHA2-256SUMS` (and the `digest` GitHub
  lists for the asset), unpack it with `ditto -x -k`, and run `lipo -archs` and `--version` on `yt-dlp_macos`. Then:
  1. In `tools.json`, update `version`, `url`, `sha256`, `sourceUrl`, `sourceSha256` (the `yt-dlp.tar.gz` line) and
     `checksumSource`.
  2. Check `links`: list the unpacked folder's symbolic links (`find . -type l`) and its duplicate files. If the zip
     now keeps links, the entries are simply found in place; if the Python version changed (`Versions/3.14`), update
     the `Versions/Current` target. `fetch.mjs` refuses a link whose copy is not identical.
  3. Replace `licenses/yt-dlp/LICENSE` and `THIRD_PARTY_LICENSES.txt` with the files from the new tag, and re-read the
     README's "Licensing" section in case it changed.
  4. Run the fetch, the YouTube tests, and the live test once (`MERGELANE_YOUTUBE_LIVE=1`, see
     `app/e2e/youtubeLive.spec.ts`).
- **Deno:** `gh api repos/denoland/deno/releases/latest`. Download `deno-aarch64-apple-darwin.zip`, its
  `.zip.sha256sum` and `deno-aarch64-apple-darwin.sha256sum` from that release. Check the zip against the first,
  unpack it with `ditto -x -k`, check the program against the second, and run `lipo -archs` and `deno --version`. In
  `tools.json`, update `version`, `url`, `sha256`, `binarySha256`, `sourceUrl`, `checksumSource` and
  `binaryChecksumSource`. Replace `licenses/deno/LICENSE.md` with the file from the new tag. yt-dlp 2026.10.26 needs
  Deno 2.3.0 or later (`MIN_SUPPORTED_VERSION` in `yt_dlp/utils/_jsruntime.py`); check that again when either
  changes. Then update `deno-notices.json` and regenerate the notices:
  1. `deno`: the version, the tag's commit (`gh api repos/denoland/deno/git/ref/tags/vX.Y.Z`), and the SHA-256 of the
     release's `deno_src.tar.gz` (GitHub lists it as the asset's `digest`).
  2. The V8 components: find the `v8` crate's version in the new `Cargo.lock`, read the commit in its
     `.cargo_vcs_info.json` (or rusty_v8's tag), and take each submodule's commit from rusty_v8 at that commit
     (`gh api 'repos/denoland/rusty_v8/contents/<path>?ref=<commit>'`). List each one's top-level licence files, and
     update the URLs. TypeScript's version is in `cli/tsc/00_typescript.js` (`var version`), Node.js's in
     `ext/node/lib.rs` (`NODE_VERSION`).
  3. Run the generator. Its summary lists any crate without a licence text: pin that crate's repository files at the
     commit in its `.cargo_vcs_info.json` (`crateFallbacks`), or add the standard text of its licence (`spdxTexts`).
  4. Read the diff of `THIRD-PARTY-NOTICES.txt`, and run its tests.

Afterwards, run the tests, update the versions and checksums in `THIRD-PARTY-NOTICES.md`, and delete the scratch
folder. CI caches `app/resources/bin` by the hash of `tools.json`, the licence texts, `build-ffmpeg.sh` and
`fetch.mjs`, so any of these changing fetches and builds afresh.

## Where they go in the app

The fetch writes to `app/resources/bin/` (ignored by git). Packaging (`app/electron-builder.yml`, `extraResources`)
then copies:

- the folder `yt-dlp/` to `Mergelane.app/Contents/Resources/yt-dlp/` (the program is `yt-dlp/yt-dlp_macos`; links are
  kept);
- `ffmpeg` and `deno` to `Contents/Resources/ffmpeg` and `…/deno`;
- the licence texts to `Contents/Resources/licenses/`.

electron-builder re-signs every Mach-O file inside the bundle, the yt-dlp folder's included, ad-hoc with the hardened
runtime. `scripts/ci/package-test.sh` checks the result: every Mach-O file verifies, `yt-dlp_macos --version` runs,
FFmpeg is arm64, runs, reports the LGPL and was configured without `--enable-gpl`, `--enable-version3` or
`--enable-nonfree`, Deno runs JavaScript, and the licence texts are there.

The app finds them with `resolveToolPath` (`app/src/main/media/mux/tools.ts`): in the bundle when packaged, in
`app/resources/bin/` in development, or where `MERGELANE_FFMPEG_PATH`, `MERGELANE_YTDLP_PATH` (the program, not the
folder) or `MERGELANE_DENO_PATH` point (development and tests only).

## On Windows (W3, ADR-0057)

The same three tools and versions, for Windows x64 and arm64, all fetched or built on the Mac:

```sh
cd app && npm run fetch:media-tools:win   # app/resources/bin-win/x64 and arm64
```

- **Manifests:** `scripts/media-tools/tools-windows-x64.json` and `tools-windows-arm64.json`, one per chip. Their
  top-level `"platform": "win32"` and `"arch"` tell `fetch.mjs` to name programs `<name>.exe` and to check each
  program's chip from its PE header (Microsoft Learn, "PE Format": the machine type after the `PE\0\0` signature),
  where macOS uses `lipo`.
- **yt-dlp:** the official unpacked Windows builds (`yt-dlp_win.zip`, `yt-dlp_win_arm64.zip`): `yt-dlp.exe` (on arm64
  `yt-dlp_arm64.exe`, as yt-dlp names it) beside `_internal\`, for the same reason as on macOS (ADR-0031: nothing unpacked to a temporary folder on every run).
- **Deno:** the official `deno-<chip>-pc-windows-msvc.zip`, pinned by the zip's and the program's SHA-256s, both from
  Deno's own `.sha256sum` files.
- **FFmpeg:** `build-ffmpeg-windows.sh` builds it on the Mac with llvm-mingw (a clang toolchain for Windows, both
  chips, pinned by SHA-256), with zlib built from its pinned source and linked in statically, so the program needs
  only Windows' own DLLs (the script checks its imports). The same component lists as `build-ffmpeg.sh`, word for
  word (`fetch.test.mjs` checks), and the same LGPL guard, read from `config.h` since a Windows program can't run
  here. x64's hand-written assembly is left out (`--disable-x86asm`): it needs nasm, and stream copy decodes almost
  nothing. `fetch.mjs` passes the chip (`buildArgs`) and the two pinned archives (`buildInputs`) to the script, and
  rebuilds when any of them changes.
- **In the app:** `electron-builder.yml`'s `win:` section ships `resources/bin-win/<chip>/` as `yt-dlp\`,
  `ffmpeg.exe`, `deno.exe` and `licenses\`; `app/src/main/media/mux/tools.ts` `WINDOWS_TOOL_PROGRAM` names them.
- **Updating:** change the version in `tools.json` and both Windows manifests together (the tests check they
  match), and take the Windows archives' SHA-256s from yt-dlp's `SHA2-256SUMS` and Deno's `.sha256sum` files.

## Open questions for the owner

1. **The yt-dlp links repair.** `fetch.mjs` turns the three framework copies in `yt-dlp_macos.zip` back into links so
   the app can be signed (see the yt-dlp section). The alternative is to leave `_internal/Python.framework` out
   altogether: no Mach-O file in the folder links to it (`otool -L`: macOS's libraries and the folder's own
   `libssl`, `libcrypto` and `libzstd`; the Python library is `_internal/Python`), which would save another 14 MB,
   but it removes upstream files instead of restoring their layout, and was not tested. Keep the repair (current
   choice) or switch?
2. **ffprobe:** yt-dlp's README lists ffmpeg and ffprobe as recommended. Mergelane runs yt-dlp only to list formats
   (`--dump-single-json`) and does the downloading and joining itself, so neither is used by yt-dlp; the build has
   ffprobe disabled. Close this question?
3. **GPG check for yt-dlp:** also verify yt-dlp's GPG signature on `SHA2-256SUMS` when updating? GPG is now available
   on this Mac (`/opt/homebrew/bin/gpg`); yt-dlp's public key would need to be pinned like FFmpeg's.
4. ~~**Deno's bundled components**~~: done (2026-11-11). `licenses/deno/THIRD-PARTY-NOTICES.txt`, generated by
   `scripts/media-tools/deno-notices.mjs`; see "Deno's bundled components" above for what it covers and what it
   doesn't. Remaining choice: 25 crates are covered by the standard text of their licence, without their authors'
   copyright lines, because neither their package nor their repository has a licence file. Accept that, or ask those
   projects (several are Deno's own: `deno_core_icudata`, `deno_native_certs`, `deno_tunnel`, `rustls-tokio-stream`)?
