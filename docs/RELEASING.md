# Releasing Mergelane

How to cut a release. One GitHub Actions workflow (`.github/workflows/release.yml`) builds the app, tests it, and
creates a **draft** release on GitHub. Nothing is public until you read the draft and press Publish.

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

## Testing the notes script

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/release/notes.mjs' \
  scripts/release/notes.test.mjs
node --test --experimental-test-coverage --test-coverage-include='scripts/media-tools/sources.mjs' \
  scripts/media-tools/sources.test.mjs
```

To preview the checks on your own machine: `node scripts/release/notes.mjs --version 1.2.3 --check`.
