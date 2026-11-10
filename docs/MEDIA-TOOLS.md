# Media tools: yt-dlp, FFmpeg and Deno

Mergelane uses three outside programs for video:

- **yt-dlp** finds a YouTube video's formats (ADR-0026). Mergelane downloads them itself.
- **FFmpeg** joins separate audio and video tracks, and turns HLS and DASH streams into normal files.
- **Deno** is the JavaScript runtime yt-dlp runs YouTube's player challenges in (see "Deno" below).

CLAUDE.md requires that all of them ship only as separate programs inside the app, fetched when the app is built,
checked against pinned SHA-256 checksums, and never committed to git. This page says which exact builds we use, why, and
what their licences ask of us.

## In short

| | yt-dlp | FFmpeg |
|---|---|---|
| Version | 2026.10.26 (latest release on 2026-11-10) | 9.0.2 (latest stable FFmpeg, released 2026-09-18) |
| Comes from | yt-dlp's own GitHub release | Martin Riedl's build server, ffmpeg.martin-riedl.de |
| File | `yt-dlp_macos` (37.5 MB) | `ffmpeg.zip` (28.4 MB), containing one 66.3 MB program |
| Runs on Apple silicon | Yes: a universal program with an arm64 part | Yes: arm64 only |
| Checksum published by the source | Yes, in the release's `SHA2-256SUMS` file | Yes, a `.sha256` file next to the download |
| Licence of the program we ship | GPL version 3 or later (yt-dlp's own code is Unlicense) | GPL version 3 or later |

To fetch them (on a Mac, with Node.js 22 or later, as in CI, and the Xcode command line tools):

```sh
node scripts/media-tools/fetch.mjs            # into app/resources/bin (ignored by git)
node scripts/media-tools/fetch.mjs some/dir   # or anywhere else
```

The pinned list is `scripts/media-tools/tools.json`. The licence texts are committed in
`scripts/media-tools/licenses/`, and the script copies them next to the programs.

## yt-dlp: which file and why

We use the official release from https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26, the file named
`yt-dlp_macos`. yt-dlp's README describes it as the "Universal MacOS (10.15+) standalone executable
(recommended for MacOS)".

- **It runs natively on Apple silicon.** "Universal" means the file holds two copies of the program, one for Intel
  (`x86_64`) and one for Apple silicon (`arm64`); the Mac picks the `arm64` one. `lipo -archs` reports
  `x86_64 arm64`, and running it printed `2026.10.26`.
- **It needs nothing else installed.** It carries its own Python. The other macOS-capable downloads are not suitable:
  the plain `yt-dlp` file needs Python installed on the Mac, and `yt-dlp_macos.zip` is a folder of many files
  (it starts faster, but is harder to bundle and sign; see the open questions).
- **The checksum is the publisher's.** The SHA-256 we computed,
  `0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa`, matches the line for `yt-dlp_macos` in the release's `SHA2-256SUMS` file and GitHub's own record of the upload.
  yt-dlp also signs `SHA2-256SUMS` with GPG; that signature was not checked here because GPG is not installed.
- It is ad-hoc signed (no Apple Developer ID). Mergelane re-signs everything in its bundle anyway.

For YouTube, yt-dlp also needs `yt-dlp-ejs` (its challenge-solver scripts) and a JavaScript runtime. Checked on
2026-11-11 against the pinned program:

- **The scripts are built into `yt-dlp_macos`.** Its `--verbose` header lists `yt_dlp_ejs-0.8.0` among its libraries,
  and the README says of `--remote-components`: "This option is currently not needed if you are using an official
  executable". yt-dlp checks the scripts against SHA3-512 hashes kept in its own code
  (`yt_dlp/extractor/youtube/jsc/_builtin/vendor/_info.py`, version 0.8.0), so they are pinned with the program.
- **Nothing is fetched at run time.** Mergelane passes `--no-remote-components`; yt-dlp would otherwise only fetch
  scripts from npm or GitHub when told to (`ejs:npm`, `ejs:github`, which are off by default).
- **The runtime is ours.** `--no-js-runtimes --js-runtimes deno:<path>` enables only the bundled Deno (the header
  then reads `JS runtimes: deno-2.9.8`). yt-dlp runs it as `deno run --ext=js --no-code-cache --no-prompt
  --no-remote --no-lock --node-modules-dir=none --no-config --no-npm --cached-only -`
  (`jsc/_builtin/deno.py`).
- **It starts slowly.** `yt-dlp_macos` is a PyInstaller "one-file" program: every run unpacks itself into a new
  temporary folder. On this Mac each run took about 24 seconds before doing anything (`--version` included), while
  the unpacked `yt-dlp_macos.zip` took 24 seconds once and 0.25 seconds after. Each YouTube video costs at least
  two runs (New download, then one per network as it downloads). See the open questions.

## FFmpeg: which build and why

The FFmpeg project (ffmpeg.org) publishes only source code and points to other people's builds. For macOS its
download page links to one site, evermeet.cx. These are the arm64 options that were checked, each on its own site:

| Source | Apple silicon build? | Notes | Verdict |
|---|---|---|---|
| evermeet.cx (the one ffmpeg.org links) | **No.** Intel only. The site says: "I do not plan to provide native ffmpeg binaries for Apple Silicon ARM." | Good build notes and GPG signatures, but Intel code would not meet CLAUDE.md's arm64-only rule. | Rejected |
| osxexperts.net | Yes, FFmpeg 9.0.2 (`ffmpeg902arm.zip`) | Publishes one SHA-256, without saying whether it is for the zip or the program. Does not publish the configure options. Its "Source used to compile" link points to FFmpeg's 6.1 branch, not 9.0.2. Says the files are "for educational purposes only". | Not chosen: weak provenance |
| eugeneware/ffmpeg-static (GitHub) | Yes, `ffmpeg-darwin-arm64` | Latest release b6.1.1 (November 2025). Its download script takes the macOS arm64 build from osxexperts.net (`ffmpeg6arm.zip`, FFmpeg 6). | Rejected: old and second-hand |
| Martin Riedl's build server, ffmpeg.martin-riedl.de | Yes, FFmpeg 9.0.2 release build (and snapshots) | Publishes a `.sha256` file for every download, a `versions.txt` with the exact configure line and every library version, and its build script (https://git.martin-riedl.de/ffmpeg/build-script). Each version has its own download address, and older versions stay listed. The program is signed with an Apple Developer ID ("Martin Riedl (KU3N25YGLU)") with the hardened runtime. | **Chosen** |

What was checked on the chosen download:

- The zip's SHA-256 matches the published one:
  `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924`.
- The zip holds a single file, `ffmpeg`. Its own SHA-256,
  `2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384`, is a value **we computed**; it is pinned too, so the script can check the unpacked program and skip downloads it already has.
- `lipo -archs` reports `arm64`, and `ffmpeg -version` reports 9.0.2 with the configure line below.
- `otool -L` lists only Apple's own system libraries and frameworks, so every codec library is built into the program
  (statically linked) and nothing else needs installing.

The trust trade-off: Martin Riedl's server is a one-person project and ffmpeg.org does not link to it. We rely on him
for what is inside the build. The pinned checksums mean the file can never change under us without the build failing,
and the Developer ID signature identifies who built it.

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
- So we treat the program we ship as **GPL version 3 or later**: `licenses/yt-dlp/GPL-3.0.txt`.

### FFmpeg

- FFmpeg is LGPL by default. This build was configured with `--enable-gpl --enable-version3`, which FFmpeg's own
  `configure` script turns into the licence **"GPL version 3 or later"**. It was **not** built with
  `--enable-nonfree` (which FFmpeg says makes a build "unredistributable"), so we may redistribute it.
- Why GPL: it includes x264 and x265, which FFmpeg lists as GPL libraries. It also includes OpenSSL 3 and libvmaf
  (Apache 2.0). FFmpeg's `configure` refuses OpenSSL 3 with the GPL unless `--enable-version3` is given, and its
  `LICENSE.md` asks for the same with libvmaf.
- Exact configure line of this build:

  ```text
  --prefix=/Volumes/ffmpeg_arm64/out --pkg-config-flags=--static --extra-version='https://www.martin-riedl.de'
  --enable-gray --enable-libxml2 --enable-version3 --enable-gpl --enable-openssl --enable-libfreetype
  --enable-fontconfig --enable-libharfbuzz --enable-libbluray --enable-libsnappy --enable-libsrt --enable-libvmaf
  --enable-libass --enable-libklvanc --enable-libzimg --enable-libzvbi --enable-libaom --enable-libdav1d
  --enable-libopenh264 --enable-libopenjpeg --enable-librav1e --enable-libsvtav1 --enable-libvpx --enable-libvvenc
  --enable-libwebp --enable-libx264 --enable-libx265 --enable-libmp3lame --enable-libopus --enable-libvorbis
  --enable-libtheora
  ```

- Libraries listed for this build (versions in `licenses/ffmpeg/BUILD-VERSIONS.txt`): aom, libass, libbluray, dav1d, fontconfig,
  freetype, fribidi, harfbuzz, libklvanc, lame, openh264, OpenJPEG, OpenSSL, opus, rav1e, SDL, snappy, srt, svt-av1,
  libtheora, libvmaf, libvorbis, vpx, vvenc, libwebp, x264, x265, libxml2, zimg, zlib and zvbi.
- FFmpeg's `LICENSE.md` also says three of its files come from libjpeg, and that when only the program (not source)
  is shipped, the documentation must state that "this software is based in part on the work of the Independent JPEG
  Group". That sentence goes in `THIRD-PARTY-NOTICES.md`.
- Texts: `licenses/ffmpeg/LICENSE.md` and `licenses/ffmpeg/COPYING.GPLv3`, both from FFmpeg's `n9.0.2` tag.

### Deno

- Deno is released under the **MIT** licence: `licenses/deno/LICENSE.md`, from the `v2.9.8` tag. It asks only that
  the notice ships with the program, which the fetch script and the packaging config do.
- Being MIT, it needs no source offer (ADR-0027), so `tools.json` gives no `sourceSha256` for it and the release
  doesn't attach its source.
- The program also contains V8 (BSD-3-Clause), TypeScript (Apache-2.0) and many Rust libraries under their own
  permissive licences. Deno's release publishes no list of them, and they are not collected here yet (see the open
  questions).

### What the GPL means for Mergelane

- **Mergelane stays MIT.** It runs these tools as separate programs and does not link their code into its own. The
  GPL (version 3, section 5) calls this an "aggregate": putting a GPL program in one "does not cause this License to
  apply to the other parts of the aggregate."
- **What we must do whenever we hand out a DMG:**
  1. Ship the licence texts with the programs. The fetch script and the proposed packaging config do this.
  2. Keep the authors' notices, and never present the tools as Mergelane's own work.
  3. Make the matching source code available ("Corresponding Source"): the source for exactly these builds, including
     the build scripts. Because we distribute over the internet (GitHub Releases), GPL version 3 section 6(d) lets the
     source sit on another server, even someone else's, "provided you maintain clear directions next to the object
     code saying where to find the Corresponding Source". It also says "you remain obligated to ensure that it is
     available for as long as needed".
- **Where that source is today:**
  - FFmpeg 9.0.2: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz (signed by FFmpeg; the `.asc` signature is next
    to it), plus the library sources at the versions in `BUILD-VERSIONS.txt`, and the build script at
    https://git.martin-riedl.de/ffmpeg/build-script. That repository has no tags, so the exact script revision used
    for this build is not recorded.
  - yt-dlp 2026.10.26: https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.tar.gz (its SHA-256 is
    in `tools.json`). For the bundled libraries, `THIRD_PARTY_LICENSES.txt` points to the original projects and says
    the yt-dlp maintainers will provide sources on request.
- **Recommendation:** because we stay responsible even when the source lives on someone else's server, attach the
  source archives (FFmpeg 9.0.2 with its library sources, and yt-dlp 2026.10.26) to every Mergelane GitHub release
  that ships these programs, and say so in `THIRD-PARTY-NOTICES.md`. This needs your decision (see open questions).

## How the fetch works

`scripts/media-tools/fetch.mjs` uses only Node.js built-ins and the macOS tools `ditto`, `tar` and `lipo`. For each
tool in `tools.json` it:

1. skips the tool when the installed program already has the pinned SHA-256 (it only refreshes the licence texts);
2. downloads the pinned address, following redirects. Only `https` is allowed (plain `http` only for the local test
   server);
3. checks the download's SHA-256 **before** anything is unpacked or made executable. A mismatch stops the build with
   both values printed, and the download is deleted;
4. unpacks a zip with `/usr/bin/ditto` (or a tar archive with `/usr/bin/tar`) into an empty temporary folder, refuses
   paths that lead out of it, and checks the unpacked program's own SHA-256;
5. checks that `lipo -archs` lists `arm64`;
6. copies the licence texts to `<output>/licenses/<tool>/`, then installs the program as `<output>/<tool>` with
   permissions 0755.

Any failure exits with code 1 and a message starting `fetch-media-tools:`, and leaves no half-installed program.

Tests (no network; they build tiny programs with `clang` and serve them from a local web server):

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/fetch.mjs' \
  scripts/media-tools/fetch.test.mjs
```

## Updating a pinned version

Do this in a scratch folder, never in the repository.

- **Deno:** `gh api repos/denoland/deno/releases/latest`. Download `deno-aarch64-apple-darwin.zip`, its
  `.zip.sha256sum` and `deno-aarch64-apple-darwin.sha256sum` from that release. Check the zip against the first,
  unpack it with `ditto -x -k`, check the program against the second, and run `lipo -archs` and `deno --version`. In
  `tools.json`, update `version`, `url`, `sha256`, `binarySha256`, `sourceUrl`, `checksumSource` and
  `binaryChecksumSource`. Replace `licenses/deno/LICENSE.md` with the file from the new tag. yt-dlp 2026.10.26 needs
  Deno 2.3.0 or later (`MIN_SUPPORTED_VERSION` in `yt_dlp/utils/_jsruntime.py`); check that again when either
  changes.

1. **yt-dlp:** `gh api repos/yt-dlp/yt-dlp/releases/latest`. Download `yt-dlp_macos` and `SHA2-256SUMS` from that
   release, check that `shasum -a 256 yt-dlp_macos` matches its line in `SHA2-256SUMS`, and run
   `lipo -archs` on it. In `tools.json`, update `version`, `url`, `sha256`, `sourceUrl`, `sourceSha256` (the
   `yt-dlp.tar.gz` line) and `checksumSource`. Replace `licenses/yt-dlp/LICENSE` and `THIRD_PARTY_LICENSES.txt` with
   the files from the new tag, and re-read the README's "Licensing" section in case it changed.
2. **FFmpeg:** on https://ffmpeg.martin-riedl.de, under "Download Release Build" › "macOS (Apple Silicon/arm64)", take
   the FFmpeg (ZIP) link and its SHA256 file. Download and check the zip, unpack it with `ditto -x -k`, run
   `shasum -a 256`, `lipo -archs`, `otool -L` and `ffmpeg -version` on the program. Check that the configure line
   has no `--enable-nonfree`. Update `version`, `url`, `sha256`, `binarySha256`, `sourceUrl` and `checksumSource`.
   Replace `licenses/ffmpeg/BUILD-VERSIONS.txt` with that build's `versions.txt`, and `LICENSE.md` and
   `COPYING.GPLv3` with the files from FFmpeg's new tag (for example `n9.0.3`).
3. Run the tests and the fetch, update the versions and checksums in `THIRD-PARTY-NOTICES.md`, and delete the scratch
   folder.

## Where they go in the app

The fetch writes to `app/resources/bin/` (ignored by git). Packaging then copies the programs to
`Mergelane.app/Contents/Resources/yt-dlp`, `…/ffmpeg` and `…/deno`, and the licence texts to
`…/Contents/Resources/licenses/`
(the `electron-builder.yml` change is proposed, not yet applied). In development, the app can run them from
`app/resources/bin/`.

## Open questions for the owner

1. **Source for the GPL:** attach the FFmpeg and yt-dlp source archives to each Mergelane release (safest), or rely on
   the upstream download links (allowed by the GPL, but we stay responsible if they disappear)?
2. **FFmpeg builder:** accept Martin Riedl's build server as the source of FFmpeg? The alternative with similar
   features would be building FFmpeg ourselves in CI, which is slower and more work but fully under our control.
3. **ffprobe:** yt-dlp's README lists ffmpeg *and* ffprobe as strongly recommended. The same server publishes a
   matching ffprobe 9.0.2. Add it as a third pinned tool? (It was not downloaded or checked here.)
4. **yt-dlp format:** keep the single-file `yt-dlp_macos`, or switch to the unpacked `yt-dlp_macos.zip`, which starts
   faster? The packaging test should run the bundled `yt-dlp --version` either way, because Mergelane re-signs it with
   the hardened runtime. Measured since (see "yt-dlp: which file and why"): the single file took about 24 seconds per
   run on this Mac, the unpacked one 0.25 seconds after its first run (SHA-256
   `20d98fa608998eff87d1d35a6e9fb65e4b874639a6cc89addc19da3becde3ef1`, in the same `SHA2-256SUMS`). Switching needs
   the fetch script to install a folder (134 files) rather than one program. Recommended, but ADR-0022 names the
   single file, so it is your call.
7. **Deno's bundled components:** collect the licence notices of what is built into Deno (V8, TypeScript and its Rust
   libraries) into `licenses/deno/`, as for FFmpeg's libraries in question 5?
5. **Per-library notices for FFmpeg:** the build bundles about thirty libraries, several under BSD, MIT or Apache
   licences that ask for their notices to be shipped. Collect each library's licence text into
   `licenses/ffmpeg/` as a follow-up?
6. **GPG check for yt-dlp:** also verify yt-dlp's GPG signature on `SHA2-256SUMS` when updating? It needs GPG, which is
   not installed on this Mac.
