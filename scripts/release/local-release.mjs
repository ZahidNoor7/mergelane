// Builds a Mergelane release on this Mac and, with --upload, creates it on GitHub as a draft. CI is
// paused (ADR-0020), so this replaces .github/workflows/release.yml for now, step for step;
// docs/RELEASING.md is the owner's guide.
//
// usage: node scripts/release/local-release.mjs --version <x.y.z> [--upload]
//        node scripts/release/local-release.mjs --version <x.y.z> --skip-branch-checks
//            [--changelog <file>]                         (a dry run on any branch; never uploads)
//
// What it does, in release.yml's order:
//   1. the release-notes script's tests (90% line coverage);
//   2. the checks: the version equals app/package.json's and CHANGELOG.md has its section
//      (notes.mjs --check); HEAD is the default branch (main) and equals origin's, after fetching
//      it; the working tree is clean; the tag exists neither here nor on origin; GitHub has no
//      release (draft or published) for it;
//   3. the build: both helpers with -X main.version, the media tools (fetch.mjs), electron-vite and
//      electron-builder --mac --publish never, into a fresh app/dist;
//   4. the REA fuse audit, package-test.sh in its local mode (no quarantine; an isolated launch),
//      and a check of the app in the zip (signature and version);
//   5. the release files: the bundled programs' sources (sources.mjs), SHA256SUMS of everything
//      attached, and the notes (notes.mjs);
//   6. it prints what would be uploaded, and stops. Only with --upload does it run
//      `gh release create v<version> --draft --target <commit> ...`, as release.yml does. It never
//      publishes: a draft is published by hand on GitHub (docs/RELEASING.md).
// --skip-branch-checks skips the two branch checks (HEAD at origin's main, clean tree) and
// --changelog reads another changelog; both are for a dry run only and refused with --upload.
// Every command's output goes to local-ci-logs/release-<time>.log too.
// Exit codes: 0 done; 1 a check or step failed; 2 wrong usage.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assetNames, VERSION } from './notes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')
export const DEFAULT_BRANCH = 'main'

export const USAGE = [
  'usage: node scripts/release/local-release.mjs --version <x.y.z> [--upload]',
  '       node scripts/release/local-release.mjs --version <x.y.z> --skip-branch-checks [--changelog <file>]',
  '  --upload               create the draft release on GitHub after every check and step passed',
  '  --skip-branch-checks   DRY RUN ONLY: build from any branch and an unclean tree; never uploads',
  '  --changelog <file>     DRY RUN ONLY: read this changelog instead of CHANGELOG.md',
  '  --logs <dir>           where the log goes (default: local-ci-logs/)'
].join('\n')

export class UsageError extends Error {}

/** What this script does for each step of release.yml (by its name, or its action without the
 * version). The tests fail when release.yml gains a step that is not here. */
export const MIRRORS = {
  'actions/checkout': 'this checkout; the branch checks make sure it is main at origin/main',
  'actions/setup-node': 'the Node.js on PATH',
  'Test the release-notes script': 'the same command',
  'Check the version, the changelog, the branch and the tag':
    'notes.mjs --check; HEAD is main at origin/main; a clean tree; no tag here or on origin; no release on GitHub',
  'actions/setup-go': 'the Go on PATH',
  'npm ci': 'not run: app/node_modules is already installed',
  'Build the helpers that ship inside the app': 'the same commands',
  'Fetch yt-dlp and Deno, and build FFmpeg (pinned SHA-256s, docs/MEDIA-TOOLS.md)':
    'the same command',
  'Build the arm64 DMG and zip (ad-hoc signed)': 'the same commands, into a fresh app/dist',
  'Audit Electron fuses with REA': 'the same command',
  'Install from the DMG and reach the ready state':
    'package-test.sh --local (no quarantine; an isolated launch)',
  'Check the app in the zip': 'the same checks',
  'Collect the source of the bundled programs': 'the same command',
  'Compute the checksums': 'the same list, computed by this script',
  'Write the release notes': 'the same command, into app/dist/release-notes.md',
  'Create the GitHub release': 'only with --upload, and always as a draft'
}

/** The key MIRRORS uses for a release.yml step. */
export function stepKey(step) {
  if (step.name) return step.name
  if (step.uses) return step.uses.replace(/@.*$/, '')
  return String(step.run).trim().split('\n')[0]
}

/** The command line, with the dry-run-only options refused alongside --upload. */
export function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        version: { type: 'string' },
        upload: { type: 'boolean' },
        'skip-branch-checks': { type: 'boolean' },
        changelog: { type: 'string' },
        logs: { type: 'string' },
        root: { type: 'string' }
      }
    })
  } catch (error) {
    throw new UsageError(error.message)
  }
  const values = parsed.values
  if (!values.version) throw new UsageError('--version is required')
  if (!VERSION.test(values.version)) {
    throw new UsageError(`"${values.version}" is not a version like 1.2.3 (without the "v")`)
  }
  const upload = Boolean(values.upload)
  const skipBranchChecks = Boolean(values['skip-branch-checks'])
  if (upload && skipBranchChecks) {
    throw new UsageError(
      '--skip-branch-checks is for a dry run only; it cannot be used with --upload'
    )
  }
  if (upload && values.changelog) {
    throw new UsageError('--changelog is for a dry run only; a release uses CHANGELOG.md')
  }
  const root = resolve(values.root ?? ROOT)
  return {
    version: values.version,
    tag: `v${values.version}`,
    upload,
    skipBranchChecks,
    changelog: values.changelog ? resolve(values.changelog) : null,
    root,
    logs: resolve(values.logs ?? join(root, 'local-ci-logs'))
  }
}

/** owner/repo from electron-builder.yml's publish section: where the release goes. */
export function repoFromBuilderConfig(text) {
  const publish = /^publish:\s*\n((?:[ \t]+.*\n?)+)/m.exec(text)
  const owner = publish && /^\s+owner:\s*['"]?([\w.-]+)/m.exec(publish[1])
  const repo = publish && /^\s+repo:\s*['"]?([\w.-]+)/m.exec(publish[1])
  if (!owner || !repo) throw new Error('app/electron-builder.yml has no publish owner and repo')
  return `${owner[1]}/${repo[1]}`
}

/** Problems with the branch: HEAD must be the default branch and equal origin's. */
export function branchProblems({ branch, head, originHead, defaultBranch = DEFAULT_BRANCH }) {
  const problems = []
  if (branch !== defaultBranch) {
    problems.push(
      `HEAD is ${branch || 'detached'}, not ${defaultBranch}: releases are built from ${defaultBranch}`
    )
  }
  if (!originHead) problems.push(`origin has no ${defaultBranch} branch to compare with`)
  else if (head !== originHead) {
    problems.push(
      `HEAD is ${head}, but origin/${defaultBranch} is ${originHead}: pull or push first`
    )
  }
  return problems
}

/** Problems with the working tree: `git status --porcelain` must print nothing. */
export function treeProblems(status) {
  const lines = status.split('\n').filter(Boolean)
  if (lines.length === 0) return []
  const shown = lines.slice(0, 10).map((line) => `    ${line}`)
  if (lines.length > 10) shown.push(`    ... and ${lines.length - 10} more`)
  return [
    `the working tree has ${lines.length} uncommitted change(s): commit or stash them\n${shown.join('\n')}`
  ]
}

/** Problems with the tag and the release: neither may exist yet. */
export function tagProblems({ tag, localTag, remoteTags, releases }) {
  const problems = []
  if (localTag)
    problems.push(`the tag ${tag} already exists here (at ${localTag}): bump the version`)
  if (remoteTags.trim() !== '')
    problems.push(`the tag ${tag} already exists on origin: bump the version`)
  if (
    releases
      .split('\n')
      .map((line) => line.trim())
      .includes(tag)
  ) {
    problems.push(
      `GitHub already has a release for ${tag} (perhaps a draft): delete it first, or bump the version`
    )
  }
  return problems
}

/** The SHA-256 of a file. */
export async function sha256Of(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** SHA256SUMS as `shasum -a 256` prints it: the DMG, the zip, then the sources, by name. */
export async function checksums(dist, version) {
  const { dmg, zip } = assetNames(version)
  const sources = (await readdir(join(dist, 'sources')))
    .filter((name) => !name.startsWith('.'))
    .sort()
  const lines = []
  for (const name of [dmg, zip]) lines.push(`${await sha256Of(join(dist, name))}  ${name}`)
  for (const name of sources) lines.push(`${await sha256Of(join(dist, 'sources', name))}  ${name}`)
  return { text: `${lines.join('\n')}\n`, sources }
}

/** The arguments of release.yml's `gh release create`, always as a draft. */
export function releaseArgs({ version, sha, notes, dist, sources }) {
  const { dmg, zip } = assetNames(version)
  return [
    'release',
    'create',
    `v${version}`,
    '--draft',
    ...(version.includes('-') ? ['--prerelease'] : []),
    '--target',
    sha,
    '--title',
    `Mergelane ${version}`,
    '--notes-file',
    notes,
    join(dist, dmg),
    join(dist, zip),
    join(dist, 'SHA256SUMS'),
    ...sources.map((name) => join(dist, 'sources', name))
  ]
}

const formatSize = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`

/** The environment of every command: this one without ELECTRON_RUN_AS_NODE (which would start
 * Electron as plain Node) or NODE_TEST_CONTEXT (set by a surrounding `node --test`). */
export function commandEnv(env) {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  delete clean.NODE_TEST_CONTEXT
  return clean
}

/** Runs commands, writing their output to the console and the log. Tests replace it. */
export function makeRunner({ log, print, env }) {
  return function run(
    command,
    args,
    { cwd, capture = false, allowFail = false, extraEnv = {} } = {}
  ) {
    log.write(`\n$ (cd ${cwd} && ${[command, ...args].join(' ')})\n`)
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const out = []
      child.stdout.on('data', (chunk) => {
        out.push(chunk)
        log.write(chunk)
        if (!capture) print(chunk.toString().replace(/\n$/, ''))
      })
      child.stderr.on('data', (chunk) => {
        log.write(chunk)
        if (!capture) print(chunk.toString().replace(/\n$/, ''))
      })
      child.on('error', reject)
      child.on('close', (code) => {
        const stdout = Buffer.concat(out).toString('utf8')
        if (code !== 0 && !allowFail) {
          reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
        } else resolvePromise({ code, stdout })
      })
    })
  }
}

/** The whole release. `run` executes a command (see makeRunner). Resolves to the exit code. */
export async function release(options, { run, print }) {
  const { version, tag, root } = options
  const app = join(root, 'app')
  const dist = join(app, 'dist')
  const say = (line) => print(`local-release: ${line}`)
  const stepTitle = (title) => print(`\n== ${title}`)
  const changelogArgs = options.changelog ? ['--changelog', options.changelog] : []

  stepTitle('Test the release-notes script')
  await run(
    'node',
    [
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-include=scripts/release/notes.mjs',
      '--test-coverage-lines=90',
      'scripts/release/notes.test.mjs'
    ],
    { cwd: root }
  )

  stepTitle('Check the version, the changelog, the branch, the tag and the release')
  await run(
    'node',
    ['scripts/release/notes.mjs', '--version', version, '--check', ...changelogArgs],
    { cwd: root }
  )
  const problems = []
  if (options.skipBranchChecks) {
    say(
      'DRY RUN: --skip-branch-checks: not checking that HEAD is main at origin/main and the tree is clean'
    )
  } else {
    await run('git', ['fetch', '--quiet', 'origin', DEFAULT_BRANCH], { cwd: root })
    const branch = (
      await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: root,
        capture: true,
        allowFail: true
      })
    ).stdout.trim()
    const head = (
      await run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true })
    ).stdout.trim()
    const originHead = (
      await run(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${DEFAULT_BRANCH}`],
        {
          cwd: root,
          capture: true,
          allowFail: true
        }
      )
    ).stdout.trim()
    problems.push(...branchProblems({ branch, head, originHead }))
    const status = (await run('git', ['status', '--porcelain'], { cwd: root, capture: true }))
      .stdout
    problems.push(...treeProblems(status))
  }
  const localTag = (
    await run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {
      cwd: root,
      capture: true,
      allowFail: true
    })
  ).stdout.trim()
  const remoteTags = (
    await run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], {
      cwd: root,
      capture: true
    })
  ).stdout
  const repo = repoFromBuilderConfig(readFileSync(join(app, 'electron-builder.yml'), 'utf8'))
  const releases = (
    await run('gh', ['api', '--paginate', `repos/${repo}/releases`, '--jq', '.[].tag_name'], {
      cwd: root,
      capture: true
    })
  ).stdout
  problems.push(...tagProblems({ tag, localTag, remoteTags, releases }))
  if (problems.length > 0) {
    for (const problem of problems) say(`FAIL: ${problem}`)
    return 1
  }
  const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: root, capture: true })).stdout.trim()
  say(
    `releasing ${tag} from ${sha}${options.skipBranchChecks ? ' (DRY RUN: branch checks skipped)' : ''}`
  )

  stepTitle('Build the helpers that ship inside the app')
  for (const program of ['mergelane-daemon', 'mergelane-nmhost']) {
    await run(
      'go',
      [
        'build',
        '-trimpath',
        '-ldflags',
        `-X main.version=${version}`,
        '-o',
        `bin/${program}`,
        `./cmd/${program}`
      ],
      { cwd: join(root, 'daemon') }
    )
  }

  stepTitle('Fetch yt-dlp and Deno, and build FFmpeg (pinned SHA-256s, docs/MEDIA-TOOLS.md)')
  await run('node', ['../scripts/media-tools/fetch.mjs'], { cwd: app })

  stepTitle('Build the arm64 DMG and zip (ad-hoc signed), into a fresh app/dist')
  await rm(dist, { recursive: true, force: true })
  await run('npx', ['electron-vite', 'build'], { cwd: app })
  await run('npx', ['electron-builder', '--mac', '--publish', 'never'], { cwd: app })

  stepTitle('Audit Electron fuses with REA')
  await run('node', ['../scripts/ci/audit-fuses.mjs', 'dist/mac-arm64/Mergelane.app'], { cwd: app })

  stepTitle('Install from the DMG and reach the ready state (package-test.sh, local mode)')
  const { dmg, zip } = assetNames(version)
  await run('bash', ['../scripts/ci/package-test.sh', '--local', `dist/${dmg}`, version], {
    cwd: app
  })

  stepTitle('Check the app in the zip')
  const unzipped = await mkdtemp(join(tmpdir(), 'mergelane-zip-check-'))
  try {
    await run('ditto', ['-x', '-k', join(dist, zip), unzipped], { cwd: app })
    await run(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', join(unzipped, 'Mergelane.app')],
      { cwd: app }
    )
    const zipVersion = (
      await run(
        'plutil',
        [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          join(unzipped, 'Mergelane.app/Contents/Info.plist')
        ],
        { cwd: app, capture: true }
      )
    ).stdout.trim()
    if (zipVersion !== version) {
      say(`FAIL: the app in the zip says version ${zipVersion}, expected ${version}`)
      return 1
    }
    say(`the zip's app verifies and says version ${zipVersion}`)
  } finally {
    await rm(unzipped, { recursive: true, force: true })
  }

  stepTitle('Collect the source of the bundled programs')
  await run('node', ['scripts/media-tools/sources.mjs', join(dist, 'sources')], { cwd: root })

  stepTitle('Compute the checksums')
  const sums = await checksums(dist, version)
  writeFileSync(join(dist, 'SHA256SUMS'), sums.text)
  print(sums.text.replace(/\n$/, ''))

  stepTitle('Write the release notes')
  const notes = join(dist, 'release-notes.md')
  await run(
    'node',
    [
      'scripts/release/notes.mjs',
      '--version',
      version,
      '--checksums',
      join(dist, 'SHA256SUMS'),
      '--out',
      notes,
      ...changelogArgs
    ],
    { cwd: root }
  )

  const args = releaseArgs({ version, sha, notes, dist, sources: sums.sources })
  const files = args.slice(args.indexOf(notes) + 1)
  stepTitle(options.upload ? 'Create the draft release on GitHub' : 'What would be uploaded')
  for (const file of files) {
    const hash = await sha256Of(file)
    print(
      `  ${file.slice(dist.length + 1).padEnd(44)} ${formatSize(statSync(file).size).padStart(9)}  ${hash}`
    )
  }
  print(`  notes: ${notes}`)
  print(
    `  command: gh ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`
  )
  if (!options.upload) {
    say(
      options.skipBranchChecks
        ? 'DRY RUN finished: everything was built and checked, and nothing was uploaded (branch checks were skipped, so this build must not be released).'
        : 'finished: nothing was uploaded. Run again with --upload to create the draft release.'
    )
    return 0
  }
  await run('gh', args, { cwd: root, extraEnv: { GH_REPO: repo } })
  say(
    `created the DRAFT release ${tag} on ${repo}. Review it, then publish it by hand (docs/RELEASING.md).`
  )
  return 0
}

function timestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[:T]/g, '-')
}

/** CLI entry point. Resolves to the exit code. */
export async function main(
  argv = process.argv.slice(2),
  { print = console.log, error = console.error, env = process.env, makeRun = makeRunner } = {}
) {
  let options
  try {
    options = parseCli(argv)
  } catch (failure) {
    error(`local-release: ${failure.message}`)
    error(USAGE)
    return 2
  }
  mkdirSync(options.logs, { recursive: true })
  const logFile = join(options.logs, `release-${options.version}-${timestamp(new Date())}.log`)
  const log = createWriteStream(logFile)
  print(`local-release: log: ${logFile}`)
  const wrapped = (line) => {
    log.write(`${line}\n`)
    print(line)
  }
  try {
    return await release(options, {
      run: makeRun({ log, print, env: commandEnv(env) }),
      print: wrapped
    })
  } catch (failure) {
    wrapped(`local-release: FAIL: ${failure.message}`)
    return 1
  } finally {
    await new Promise((resolveClose) => log.end(resolveClose))
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
  process.exitCode = await main()
}
