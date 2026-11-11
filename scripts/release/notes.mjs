// Builds the GitHub release notes for one Mergelane version. Used by .github/workflows/release.yml;
// docs/RELEASING.md explains the whole release. Node.js built-ins only.
//
// usage:
//   node scripts/release/notes.mjs --version <x.y.z> --check
//     Checks that the version looks like 1.2.3, equals app/package.json's version, and has its own
//     "## [x.y.z]" section in CHANGELOG.md. Run before the build, so a mistake fails in seconds.
//   node scripts/release/notes.mjs --version <x.y.z> --checksums <SHA256SUMS> [--out <file>]
//     The same checks, then writes the notes to <file> (or prints them). The notes are:
//       1. CHANGELOG.md's section for the version;
//       2. the requirements and the install steps (CLAUDE.md: they must be on the release page);
//       3. README.md's "honest limits" section, read from the README so the two never drift apart;
//       4. a table of the SHA-256 checksums of the DMG and the zip;
//       5. where to get the source code of the GPL programs inside the app (yt-dlp and FFmpeg),
//          from each tool's sourceUrl in scripts/media-tools/tools.json (docs/MEDIA-TOOLS.md).
//
// --changelog, --readme, --manifest and --package replace the repository's own files (for tests).
// Exit codes: 0 done; 1 the release is not ready, and the message says why; 2 wrong usage.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

export const DEFAULTS = {
  changelog: join(ROOT, 'CHANGELOG.md'),
  readme: join(ROOT, 'README.md'),
  manifest: join(ROOT, 'scripts/media-tools/tools.json'),
  package: join(ROOT, 'app/package.json')
}

export const USAGE = [
  'usage: node scripts/release/notes.mjs --version <x.y.z> --check',
  '       node scripts/release/notes.mjs --version <x.y.z> --checksums <SHA256SUMS> [--out <file>]',
  'options: --changelog <file> --readme <file> --manifest <tools.json> --package <package.json>'
].join('\n')

/** A Semantic Versioning version without build metadata: 1.2.3 or 1.2.3-beta.1. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/** Wrong use of the command line: exit code 2 instead of 1. */
export class UsageError extends Error {}

/** The files electron-builder makes for a version (app/electron-builder.yml's artifactName settings). */
export function assetNames(version) {
  return {
    dmg: `Mergelane-${version}-arm64.dmg`,
    zip: `Mergelane-${version}-arm64-mac.zip`
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
// A level-1 or level-2 ATX heading. Level 3 and deeper stay inside the section's text.
const HEADING = /^ {0,3}(#{1,2})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
// Keep a Changelog ends the file with link definitions such as "[unreleased]: https://..." and
// "[1.2.3]: https://...". They would otherwise end up at the bottom of the last section.
const VERSION_LINK_DEFINITION = /^ {0,3}\[(unreleased|v?\d+\.\d+\.\d+[^\]]*)\]:\s*\S+/i

/** Splits Markdown into its level-2 sections, ignoring "#" lines inside fenced code blocks. */
export function sections(markdown) {
  const found = []
  let current = null
  let fence = null
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMark = FENCE.exec(line)
    if (fenceMark) {
      const mark = fenceMark[1]
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
    } else if (fence === null) {
      const heading = HEADING.exec(line)
      if (heading) {
        current = heading[1] === '##' ? { heading: heading[2], lines: [] } : null
        if (current) found.push(current)
        continue
      }
    }
    current?.lines.push(line)
  }
  return found.map(({ heading, lines }) => ({ heading, body: tidy(lines) }))
}

/** Drops leading and trailing blank lines and Keep a Changelog's trailing link definitions. */
function tidy(lines) {
  let end = lines.length
  while (end > 0 && (lines[end - 1].trim() === '' || VERSION_LINK_DEFINITION.test(lines[end - 1]))) {
    end--
  }
  let start = 0
  while (start < end && lines[start].trim() === '') start++
  return lines.slice(start, end).join('\n')
}

/** The text of the first level-2 section whose heading passes `matches`, or null. */
export function findSection(markdown, matches) {
  return sections(markdown).find(({ heading }) => matches(heading))?.body ?? null
}

/** CHANGELOG.md's "## [version]" or "## [version] - date" section, or null when there is none. */
export function changelogSection(changelog, version) {
  return findSection(changelog, (heading) => /^\[([^\]]+)\]/.exec(heading)?.[1] === version)
}

/** README.md's "What to expect (honest limits)" section, or null. */
export function honestLimits(readme) {
  return findSection(readme, (heading) => /honest limits/i.test(heading))
}

/** Problems that stop the release; empty means the version can be released. */
export function checkRelease({ version, packageVersion, changelog }) {
  if (!VERSION.test(version)) {
    const hint = /^v\d/.test(version) ? ': leave out the leading "v"' : ''
    return [`"${version}" is not a version like 1.2.3${hint}`]
  }
  const problems = []
  if (packageVersion !== version) {
    problems.push(
      `app/package.json has version ${JSON.stringify(packageVersion)}, not "${version}": bump it first`
    )
  }
  const section = changelogSection(changelog, version)
  if (section === null) {
    problems.push(`CHANGELOG.md has no "## [${version}]" section: add one with this release's changes`)
  } else if (section === '') {
    problems.push(`CHANGELOG.md's "## [${version}]" section is empty`)
  }
  return problems
}

const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/

/** Parses `shasum -a 256` output into [{ file, sha256 }], throwing on anything else. */
export function parseChecksums(text) {
  const entries = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return
    const match = CHECKSUM_LINE.exec(line)
    if (!match) {
      throw new Error(`checksum line ${index + 1} is not "<sha256>  <file>": ${JSON.stringify(line)}`)
    }
    const [, sha256, file] = match
    if (file.includes('/')) {
      throw new Error(`checksum line ${index + 1} names a path, ${file}: run shasum next to the files`)
    }
    entries.push({ file, sha256 })
  })
  if (entries.length === 0) throw new Error('the checksum file lists no files')
  return entries
}

/** The DMG and zip this version's notes point to must both have a checksum. */
export function missingAssets(entries, version) {
  const listed = new Set(entries.map(({ file }) => file))
  return Object.values(assetNames(version)).filter((file) => !listed.has(file))
}

export function checksumTable(entries) {
  return [
    '| File | SHA-256 |',
    '| --- | --- |',
    ...entries.map(({ file, sha256 }) => `| \`${file}\` | \`${sha256}\` |`)
  ].join('\n')
}

const DISPLAY_NAMES = { ffmpeg: 'FFmpeg' }

/** The source links the GPL asks for, one entry per tool in tools.json. Throws when one is missing. */
export function gplSources(manifest) {
  const tools = manifest?.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('the media-tools manifest has no "tools" list')
  }
  return tools
    .map((tool) => {
      if (typeof tool?.sourceUrl !== 'string' || !tool.sourceUrl.startsWith('https://')) {
        throw new Error(`${tool?.name ?? 'a tool'} has no https sourceUrl in the media-tools manifest`)
      }
      const lines = [
        `- **${DISPLAY_NAMES[tool.name] ?? tool.name} ${tool.version}**: ${tool.license}`,
        `  - Source: <${tool.sourceUrl}>` +
          (tool.sourceSha256 ? ` (SHA-256 \`${tool.sourceSha256}\`)` : '')
      ]
      if (tool.buildScriptUrl) lines.push(`  - Build script: <${tool.buildScriptUrl}>`)
      return lines.join('\n')
    })
    .join('\n')
}

/** The fixed install section. Keep it in step with README.md's "Installing" section. */
export function installSection(version) {
  const { dmg, zip } = assetNames(version)
  return `## Requirements

macOS 27 or later, Apple silicon only (M1 or later). Intel Macs are not supported.

## Install

Mergelane is not yet signed with an Apple Developer ID, so macOS asks you to confirm it once:

1. Download \`${dmg}\` from the files below.
2. Open the DMG and drag **Mergelane** to **Applications**.
3. Open Mergelane. macOS warns that it cannot verify the app and does not open it. Close the warning.
4. Open **System Settings › Privacy & Security**, scroll to the message about Mergelane, and click
   **Open Anyway**. Confirm with your password or Touch ID.

Or, after step 2, run this in Terminal and then open the app normally:

\`\`\`sh
xattr -dr com.apple.quarantine /Applications/Mergelane.app
\`\`\`

\`${zip}\` holds the same app as a zip: unzip it, move **Mergelane** to
**Applications**, and continue from step 3.

System-wide merging needs a small helper (\`mergelane-daemon\`) that runs as a system service. Mergelane
asks for your administrator password once to install it, and you can remove it from Mergelane's settings.`
}

/** The complete release notes, as Markdown. */
export function buildNotes({ version, changes, limits, checksums, manifest }) {
  return `## What's new

${changes}

${installSection(version)}

## What to expect (honest limits)

${limits}

## Checksums

${checksumTable(checksums)}

To check a download, run \`shasum -a 256 <file>\` in Terminal and compare the result with this table.
The same list is attached as \`SHA256SUMS\`.

## Open-source programs inside the app

Mergelane's own code is MIT-licensed. For video, the app also contains these programs, shipped as
separate executables under the GNU General Public License. Their licence texts and build details (such
as the library versions built into FFmpeg) are inside the app in
\`Mergelane.app/Contents/Resources/licenses/\`, and \`THIRD-PARTY-NOTICES.md\` lists every notice.
Their source code is available here:

${gplSources(manifest)}
`
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${what} ${path}: ${error.message}`)
  }
}

function readJson(path, what) {
  const text = readText(path, what)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${what} ${path} is not valid JSON: ${error.message}`)
  }
}

function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        version: { type: 'string' },
        check: { type: 'boolean' },
        checksums: { type: 'string' },
        out: { type: 'string' },
        changelog: { type: 'string' },
        readme: { type: 'string' },
        manifest: { type: 'string' },
        package: { type: 'string' }
      }
    })
  } catch (error) {
    throw new UsageError(error.message)
  }
  const { values } = parsed
  if (!values.version) throw new UsageError('--version is required')
  if (Boolean(values.check) === Boolean(values.checksums)) {
    throw new UsageError('give either --check or --checksums <SHA256SUMS>')
  }
  if (values.check && values.out) throw new UsageError('--out goes with --checksums, not --check')
  return { ...DEFAULTS, ...values }
}

/** CLI entry point. Returns the exit code. */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  try {
    const options = parseCli(argv)
    const { version } = options
    const changelog = readText(options.changelog, 'the changelog')
    const packageVersion = readJson(options.package, 'the app package file').version
    const problems = checkRelease({ version, packageVersion, changelog })
    if (problems.length > 0) {
      for (const problem of problems) error(`release-notes: ${problem}`)
      return 1
    }
    if (options.check) {
      log(`release-notes: ${version} is ready: app/package.json and CHANGELOG.md agree`)
      return 0
    }

    const checksums = parseChecksums(readText(options.checksums, 'the checksum file'))
    const missing = missingAssets(checksums, version)
    if (missing.length > 0) throw new Error(`the checksum file does not list ${missing.join(' or ')}`)
    const limits = honestLimits(readText(options.readme, 'the README'))
    if (!limits) throw new Error('README.md has no "## ... (honest limits)" section to copy')
    const notes = buildNotes({
      version,
      changes: changelogSection(changelog, version),
      limits,
      checksums,
      manifest: readJson(options.manifest, 'the media-tools manifest')
    })
    if (options.out) {
      writeFileSync(options.out, notes)
      log(`release-notes: wrote ${options.out}`)
    } else {
      log(notes)
    }
    return 0
  } catch (failure) {
    error(`release-notes: ${failure.message}`)
    if (failure instanceof UsageError) {
      error(USAGE)
      return 2
    }
    return 1
  }
}

/** True when this file is the script Node was started with (Node runs the main module by real path). */
function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  process.exitCode = main()
}
