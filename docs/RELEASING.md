# Releasing Mergelane

How to cut a release. Nothing is public until you read the **draft** release on GitHub and press Publish.

There are two ways to build one, with the same steps:

- **On this Mac** (the way for now: CI is paused, ADR-0020): `scripts/release/local-release.mjs`, below in
  "Releasing from this Mac". `scripts/ci/local.sh` runs CI's other checks here ("Checking a build on this Mac").
- **On GitHub:** the `.github/workflows/release.yml` workflow, described in the rest of this guide.

## Releasing from this Mac

`scripts/release/local-release.mjs` does what `release.yml` does, in the same order, and stops before uploading
anything unless you say `--upload`. It never publishes: with `--upload` it creates a **draft**, and you publish it by
hand on GitHub, as in steps 5 and 6 below. Every command's output also goes to `local-ci-logs/release-<version>-<time>.log`.

You need: this Mac (Apple silicon, macOS 27), Node.js, Go, the Xcode command line tools, `app/node_modules` installed,
and `gh` signed in to an account that can push to the repository (`gh auth status`). The FFmpeg build and the packaging
test take about 10 minutes in all.

1. Bump the version and update the changelog (steps 1 and 2 below), commit, and get the commit onto `main` on GitHub.
2. Check out `main`, with nothing uncommitted, at the same commit as GitHub's `main`.
3. Build and check everything, without uploading:

   ```sh
   node scripts/release/local-release.mjs --version 1.2.3
   ```

   It:
   1. runs the release-notes script's tests;
   2. checks that `1.2.3` is `app/package.json`'s version and has its `CHANGELOG.md` section, that you are on `main`
      at the same commit as `origin/main` (after `git fetch`), that nothing is uncommitted, and that neither the tag
      `v1.2.3` (here or on GitHub) nor a release for it (even a draft) exists yet;
   3. builds both helpers stamped with the version, fetches yt-dlp and Deno and builds FFmpeg, and builds the DMG and
      the zip into a fresh `app/dist`;
   4. audits the Electron fuses, runs the packaging test in its local mode (below), and checks the app in the zip;
   5. collects the bundled programs' sources into `app/dist/sources`, writes `app/dist/SHA256SUMS` and
      `app/dist/release-notes.md`;
   6. lists what it would upload, with sizes and SHA-256s, and the exact `gh` command.
4. If you're happy, run it again with `--upload`. It repeats every check and step, then runs
   `gh release create v1.2.3 --draft --target <commit> ...` with the DMG, the zip, `SHA256SUMS` and the sources.
5. Review the draft and publish it by hand (steps 5 and 6 below).

**A dry run on any branch.** `--skip-branch-checks` skips the two branch checks (on `main` at `origin/main`, nothing
uncommitted), and `--changelog <file>` reads another changelog (for example one with a section for a version that
`CHANGELOG.md` doesn't have yet). Both exist only to try the build before a release; they are refused together with
`--upload`, and the output says DRY RUN. A build made that way must not be released.

The tests (no build, no upload): `node --test --experimental-test-coverage
--test-coverage-include='scripts/release/local-release.mjs' scripts/release/local-release.test.mjs`. They also fail when
`release.yml` gains a step this script has no counterpart for.

## Checking a build on this Mac

`scripts/ci/local.sh` runs every job of `.github/workflows/ci.yml` that needs no root: `repo-checks`, `app-checks`,
`app-e2e-smoke`, `package`, `daemon` and `extension-e2e`. It reads the commands from `ci.yml` itself, so a step added
there runs here too; a step it can't run here (one that needs root, an action it doesn't know, a `${{ }}` expression)
stops it until `scripts/ci/local.mjs` has a rule for it, with the reason. The jobs that need root (`netsim`,
`daemon-acceptance`, `app-acceptance`) are run by `scripts/ci/local-root.sh`.

```sh
scripts/ci/local.sh                  # every job that needs no root, one after another
scripts/ci/local.sh --job daemon     # one job (repeat --job, or separate names with commas)
scripts/ci/local.sh --keep-going     # run the rest after a job fails
scripts/ci/local.sh --list           # the jobs and steps, and why some are left out
```

What differs from CI, and why:

- `npm ci` is never run: `app/node_modules` is already installed, and may be shared with another checkout.
- Homebrew's FFmpeg (`/opt/homebrew/bin/ffmpeg`, or `--fixture-ffmpeg <path>`) replaces `brew install ffmpeg`.
- The daemon job's two loopback aliases need root, so the 7 tests that need them skip themselves.
- Every step runs with `CI=true`, without `ELECTRON_RUN_AS_NODE` (set in some shells, it would start Electron as plain
  Node), and with `MERGELANE_PACKAGE_TEST_LOCAL=1` (below). `go test` runs with `GOFLAGS=-v -count=1`, so its tests
  can be counted and are never answered from Go's test cache.
- `~/Downloads` is guarded: its entries are listed before and after each job, and anything new fails the run.
- The `daemon/mergelane-daemon` binary that the daemon job builds as a check is removed afterwards; `app/dist` (the
  package job's DMG and zip) is kept, ignored by git.

Each run writes `local-ci-logs/<time>/`: a log per job, the scripts it ran (`steps/`), and `summary.txt`, the table it
prints at the end (each job's result, time, test counts and line coverage).

### The packaging test's local mode

`scripts/ci/package-test.sh --local` (or `MERGELANE_PACKAGE_TEST_LOCAL=1`) is how this Mac runs the packaging test
without reaching your own Mergelane:

- **No quarantine flag, ever**, so macOS never shows its "could not verify" dialog. The Gatekeeper assessment, which
  needs the flag, is skipped, and the output says so. A DMG that already carries the flag (a downloaded one) is refused.
  Everything else is checked as in CI: every Mach-O file's signature, the metadata, the licences, the helpers and tools.
- **Its own home and data folders.** The app is started directly with `HOME` and `CFFIXED_USER_HOME` pointing at an
  empty test folder and `--user-data-dir` at another. Electron takes its home folder (where it registers the browsers'
  native messaging hosts) and its Library, Downloads and log folders from macOS's home folder, which follows
  `CFFIXED_USER_HOME` (Chromium's `NSHomeDirectory()`; Apple's CoreFoundation reads that variable first); setting only
  `HOME` was tried and is not enough. `--user-data-dir` gives the copy its own settings and its own single-instance
  lock, so it never hands over to a Mergelane you have running. `--use-mock-keychain` keeps Chromium's cookie key out of
  your login keychain.
- **It quits by process ID**, never by bundle ID, which could quit your Mergelane.
- **It proves it.** Before and after, it records every file under `~/Library/Application Support/Mergelane` and the
  Chrome, Chrome for Testing, Chromium and Firefox `NativeMessagingHosts` folders (with SHA-256s and modification
  times), Mergelane's caches, logs, preferences and saved state, its keychain item (attributes only, never the secret)
  and which app opens `mergelane:` and `magnet:` links, and fails if anything changed.
- **Preferences are compared by content.** Electron writes three keys into the app's preferences on every launch
  (`AppleTextDirection`, `NSForceRightToLeftWritingDirection`, `NSTreatUnknownArgumentsAsOpen`), and macOS's
  preferences service saves them under your real home even with `CFFIXED_USER_HOME` set. So the test may leave
  `~/Library/Preferences/io.github.zahidnoor7.mergelane.plist` holding just those three, as your own Mergelane does
  when it opens. The test reads the preferences with `defaults export`, leaves those three keys out, and compares
  everything else. If your Mergelane is running and
  writes its own files during the test, the test fails and says so: quit it and run again.
- The app registers itself for `mergelane:` links by bundle ID on every start. That leaves your settings as they were
  only when they already name Mergelane, so if they don't (Mergelane never opened on this Mac), the launch is skipped
  with a message. The temporary copy's LaunchServices record is removed after the launch.

## What the workflow does

You start it by hand. It never runs on a push, a pull request or a tag, because CI is paused (ADR-0020). It runs
on GitHub's macOS 27 runner (`xcode-27`) and:

1. runs the release-notes script's tests, then checks that the version you typed matches `app/package.json`, that
   `CHANGELOG.md` has a section for it, that you started it from `main`, and that no release for that version
   exists already (a tag that exists must point at the commit being built);
2. builds the helper (`mergelane-daemon`) and the browser host (`mergelane-nmhost`), stamped with the version;
3. fetches yt-dlp and Deno, and builds FFmpeg from its source release (ADR-0028), each download checked against its
   pinned SHA-256 (`docs/MEDIA-TOOLS.md`). The FFmpeg build uses the runner's Xcode command line tools;
4. builds the DMG and the zip, ad-hoc signed (there is no Apple Developer ID yet, ADR-0003);
5. audits the Electron fuses with REA (ADR-0016);
6. installs the DMG the way a user does, launches it and waits until it reports ready (`scripts/ci/package-test.sh`,
   ADR-0013), then checks the app inside the zip as well;
7. collects the source code the bundled programs' licences ask us to offer (ADR-0027) with
   `scripts/media-tools/sources.mjs`: yt-dlp's source tarball, FFmpeg's source tarball and FFmpeg's build script, each
   checked against its pinned SHA-256;
8. computes `SHA256SUMS` for the DMG, the zip and those source files;
9. writes the release notes with `scripts/release/notes.mjs`;
10. creates the release `v<version>` with the DMG, the zip, `SHA256SUMS` and the source files attached.

If any step fails, nothing is uploaded.

The release notes contain:

- your `CHANGELOG.md` section for the version;
- the requirements (macOS 27 or later, Apple silicon only) and the install steps, including **Open Anyway** and
  the `xattr` command (CLAUDE.md requires them on the release page);
- the honest limits, copied from `README.md`'s "What to expect (honest limits)" section;
- the checksums of every attached file;
- the programs inside the app and their licences: yt-dlp (GPL-3.0-or-later), FFmpeg (LGPL-2.1-or-later) and Deno
  (MIT), with the names of the attached source archives and build script and the upstream links, all taken from
  `scripts/media-tools/tools.json`. The notes script stops if `SHA256SUMS` doesn't list every file the notes say is
  attached, or if a GPL or LGPL program has no pinned source.

## Before the first release

- The workflow file must be on `main`. GitHub shows the **Run workflow** button only for workflows on the default
  branch.
- Releases must be started from `main`, and the workflow stops if they're not. Two reasons: those are the reviewed
  commits, and GitHub's docs say that when the release commit adds or changes workflow files compared with the
  default branch, creating the release needs a token allowed to change workflows, which the workflow's own token
  can never be.

## Cutting a release, step by step

### 1. Bump the version

In `app/`, run:

```sh
npm version 1.2.3 --no-git-tag-version
```

This sets the version in `package.json` and `package-lock.json`, and makes no commit or tag. Use a plain version
like `1.2.3`, without a `v`. A pre-release like `1.2.3-beta.1` also works, and is marked as a pre-release on GitHub.

### 2. Update the changelog

In `CHANGELOG.md`, rename `## [Unreleased]` to the version and today's date, and start a new, empty
`## [Unreleased]` above it:

```markdown
## [Unreleased]

## [1.2.3] - 2026-12-01

### Added

- ...
```

The workflow uses the text under `## [1.2.3]` as the top of the release notes, so write it for users. It stops if
the section is missing or empty.

### 3. Merge to main

Open a pull request with the two changes and merge it into `main` as usual.

### 4. Start the workflow

Either:

- **On GitHub:** **Actions** › **release** › **Run workflow**. Keep the branch on `main`, type the version (for
  example `1.2.3`), leave **draft** ticked, and click **Run workflow**.
- **In Terminal:**

  ```sh
  gh workflow run release.yml --ref main -f version=1.2.3
  gh run watch          # optional: follow it until it ends
  ```

Most of the time goes on the build and the packaging test; the job is allowed 45 minutes. The run's summary page
shows the release notes once they're written.

### 5. Review the draft

Open the repository's **Releases** page. The draft `v1.2.3` is visible only to people with write access. Check:

- the notes read well, and the install steps and checksums are there;
- six files are attached: `Mergelane-1.2.3-arm64.dmg`, `Mergelane-1.2.3-arm64-mac.zip`, `SHA256SUMS`, and the source
  files: `yt-dlp-<version>-source.tar.gz`, `ffmpeg-<version>-source.tar.xz` and `ffmpeg-<version>-build-ffmpeg.sh`
  (with the versions in `tools.json`, for example `ffmpeg-9.0.2-source.tar.xz`);
- ideally, download the DMG and install it on your own Mac following the notes, to see what users will see.

You can edit the notes in the draft directly.

### 6. Publish

Click **Edit** on the draft, then **Publish release**. Or, in Terminal:

```sh
gh release edit v1.2.3 --draft=false
```

Publishing makes the release public. Its tag, `v1.2.3`, points at the commit that was built and tested.

## When something goes wrong

| What the run says | What to do |
| --- | --- |
| `app/package.json has version ...` | Step 1 was missed or used another number. Fix it on `main` and run again. |
| `CHANGELOG.md has no "## [1.2.3]" section` or `... is empty` | Do step 2, merge, and run again. |
| `Run the release from main` | Start it again with the branch set to `main`. |
| `Tag v1.2.3 already points at ...` | That version was tagged on another commit. Use a new version, or delete the tag if it was a mistake. |
| `A release for v1.2.3 already exists` | A draft from an earlier run is still there. Delete it (below) and run again. |
| The fuse audit, the packaging test or the zip check fails | The build is not safe to ship. Nothing was uploaded. Fix the cause in a pull request first. |
| `fetch-media-tools: ffmpeg: the build failed: ...` | FFmpeg did not compile; the message ends with the build's last lines. Reproduce with `node scripts/media-tools/fetch.mjs` on a Mac and fix `build-ffmpeg.sh` in a pull request. |
| `media-tools sources: ...` or `the checksum file does not list ...-source...` | A source archive could not be downloaded or did not match its pinned SHA-256, so the release would not carry the source it promises. Check the upstream link in `tools.json`; never ship without it. |

To delete a draft you don't want, open it on the **Releases** page and delete it, or in Terminal:

```sh
gh release delete v1.2.3          # finds drafts too; asks to confirm, add --yes to skip
```

If you set **draft** to off when starting the workflow, the release is published straight away. Keep it on unless
you've already checked an identical build.

## What a release does not do yet

- **No notarization.** Users confirm the app once with **Open Anyway** (ADR-0003). When there is an Apple Developer
  account, signing and notarization are switched on in `app/electron-builder.yml` and with secrets; this workflow
  then needs those secrets passed to the build step.
- **No automatic updates.** The app doesn't download updates itself (ADR-0010). Users download the new DMG.

## Testing the scripts

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/release/notes.mjs' \
  scripts/release/notes.test.mjs
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/sources.mjs' \
  scripts/media-tools/sources.test.mjs
```

To preview the checks on your own machine: `node scripts/release/notes.mjs --version 1.2.3 --check`.

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/release/local-release.mjs' \
  scripts/release/local-release.test.mjs
node --test --experimental-test-coverage --test-coverage-include='scripts/ci/local.mjs' scripts/ci/local.test.mjs
```
