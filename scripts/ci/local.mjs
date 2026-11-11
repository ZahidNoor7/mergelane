// Runs every CI check that needs no root on this Mac (CI is paused, ADR-0020). Used through
// scripts/ci/local.sh; docs/RELEASING.md ("Checking a build on this Mac") explains it.
//
// The jobs and their commands are read from .github/workflows/ci.yml, so a step added there runs
// here too. Each `run` step runs as GitHub runs it: the script is written to a file and run with
// `bash -e <file>` (or `bash --noprofile --norc -eo pipefail <file>` for `shell: bash`), in the
// step's working directory, with CI=true. What can't run here is decided by the rules below, each
// with its reason, and a step nobody has decided about stops the plan:
//   - a job that needs root (sudo, or the simulated-network scripts) is left to
//     scripts/ci/local-root.sh;
//   - `npm ci` is never run: app/node_modules may be shared with another checkout;
//   - `brew install ffmpeg` is replaced by Homebrew's FFmpeg already on this Mac
//     (MERGELANE_E2E_FIXTURE_FFMPEG);
//   - the daemon job's loopback aliases need root; the tests that need them skip themselves;
//   - `uses:` actions are replaced by this checkout and the tools on PATH.
// Every run also gets ELECTRON_RUN_AS_NODE removed (an Electron or Playwright run would otherwise
// start Electron as plain Node) and MERGELANE_PACKAGE_TEST_LOCAL=1 (package-test.sh's local mode:
// no quarantine flag, and the app launched with its own home and data folders).
//
// ~/Downloads is guarded: its entries are listed before and after every job, and anything new fails
// the run. Each run writes its logs to local-ci-logs/<time>/ (ignored by git) and prints a table of
// the jobs with their test counts and coverage. Node.js built-ins only.
//
// usage: node scripts/ci/local.mjs [--job <name>]... [--keep-going] [--list] [--dry-run]
//        [--logs <dir>] [--downloads <dir>] [--fixture-ffmpeg <path>] [--workflow <ci.yml>]
//        [--root <repo>]
// Exit codes: 0 every job passed; 1 a job failed; 2 wrong usage or a ci.yml step with no rule.
import { spawn } from 'node:child_process'
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '../..')
export const DEFAULT_WORKFLOW = join(ROOT, '.github/workflows/ci.yml')
export const DEFAULT_LOG_ROOT = join(ROOT, 'local-ci-logs')
/** Homebrew's full FFmpeg, test-only: it makes the e2e suite's sample media (docs/MEDIA-TOOLS.md). */
export const DEFAULT_FIXTURE_FFMPEG = '/opt/homebrew/bin/ffmpeg'
/** GitHub's default job timeout, for a job without timeout-minutes. */
const DEFAULT_TIMEOUT_MINUTES = 360
/** How long a step gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 10_000

export const USAGE = [
  'usage: scripts/ci/local.sh [--job <name>]... [--keep-going] [--list] [--dry-run]',
  '       [--logs <dir>] [--downloads <dir>] [--fixture-ffmpeg <path>]',
  '  --job <name>        run only this job (repeat, or separate names with commas)',
  '  --keep-going        run the remaining jobs after one fails',
  '  --list              print the jobs and their steps, then exit',
  '  --dry-run           print what would run, without running it',
  '  --logs <dir>        where the logs go (default: local-ci-logs/)',
  '  --downloads <dir>   the folder no test may write to (default: ~/Downloads)',
  '  --fixture-ffmpeg    the full FFmpeg the e2e suite makes its media with',
  '                      (default: /opt/homebrew/bin/ffmpeg)'
].join('\n')

/** Wrong use of the command line, or a ci.yml this script can't follow: exit code 2. */
export class UsageError extends Error {}

// ---------------------------------------------------------------------------------------------
// A small YAML reader for GitHub workflow files: block mappings and sequences, plain, quoted and
// block scalars (| and >, with - or + chomping), flow sequences and flow mappings of plain values,
// and comments. Anything else throws, so a workflow it can't read is never half-read.
// ---------------------------------------------------------------------------------------------

/** Parses the YAML subset GitHub workflow files use. Throws on anything outside it. */
export function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let index = 0

  const indentOf = (line) => line.length - line.trimStart().length
  const isBlank = (line) => line.trim() === '' || line.trimStart().startsWith('#')
  const fail = (message, at = index) => {
    throw new Error(`YAML line ${at + 1}: ${message}`)
  }

  function skipBlank() {
    while (index < lines.length && isBlank(lines[index])) index++
  }

  function peek() {
    skipBlank()
    if (index >= lines.length) return null
    const line = lines[index]
    if (line.includes('\t') && /^\s*\t/.test(line)) fail('tabs are not allowed for indentation')
    return { indent: indentOf(line), text: line.trim() }
  }

  function parseNode(indent) {
    const next = peek()
    if (next === null || next.indent < indent) return null
    return isSequenceItem(next.text) ? parseSequence(next.indent) : parseMapping(next.indent)
  }

  function parseSequence(indent) {
    const items = []
    for (let next = peek(); next !== null && next.indent === indent; next = peek()) {
      // A key at the sequence's own indentation ends it (YAML allows "key:" then "- item" level).
      if (!isSequenceItem(next.text)) break
      const rest = next.text === '-' ? '' : next.text.slice(2).trim()
      if (rest === '') {
        index++
        items.push(parseNode(indent + 1))
      } else if (isSequenceItem(rest) || splitKey(rest) !== null) {
        // "- key: value" starts a mapping whose keys line up after the dash ("- - x", a sequence).
        lines[index] = `${' '.repeat(indent + 2)}${next.text.slice(2).trimStart()}`
        items.push(isSequenceItem(rest) ? parseSequence(indent + 2) : parseMapping(indent + 2))
      } else {
        index++
        items.push(parseInline(rest, index - 1))
      }
    }
    const after = peek()
    if (after !== null && after.indent > indent) fail('unexpected indentation')
    return items
  }

  function parseMapping(indent) {
    const map = {}
    for (let next = peek(); next !== null && next.indent === indent; next = peek()) {
      if (isSequenceItem(next.text)) break
      const pair = splitKey(next.text)
      if (pair === null) fail(`expected "key: value", found ${JSON.stringify(next.text)}`)
      const [key, rest] = pair
      if (Object.hasOwn(map, key)) fail(`duplicate key "${key}"`)
      const at = index
      index++
      if (rest === '') {
        const child = peek()
        if (child !== null && child.indent > indent) map[key] = parseNode(child.indent)
        else if (child !== null && child.indent === indent && isSequenceItem(child.text)) {
          map[key] = parseSequence(indent)
        } else map[key] = null
      } else if (/^[|>][-+]?$/.test(rest)) {
        map[key] = parseBlockScalar(rest, indent)
      } else {
        map[key] = parseInline(rest, at)
        const continued = peek()
        if (continued !== null && continued.indent > indent) {
          fail('multi-line plain scalars are not supported; use | or >', index)
        }
      }
    }
    const after = peek()
    if (after !== null && after.indent > indent) fail('unexpected indentation')
    return map
  }

  function parseBlockScalar(header, indent) {
    const folded = header[0] === '>'
    const chomp = header[1] ?? ''
    const body = []
    let contentIndent = null
    while (index < lines.length) {
      const line = lines[index]
      if (line.trim() === '') {
        body.push('')
        index++
        continue
      }
      const lineIndent = indentOf(line)
      if (lineIndent <= indent) break
      contentIndent ??= lineIndent
      if (lineIndent < contentIndent) fail('block scalar line is less indented than its first line')
      body.push(line.slice(contentIndent))
      index++
    }
    let end = body.length
    while (end > 0 && body[end - 1] === '') end--
    const trailing = body.length - end
    const content = body.slice(0, end)
    let text = folded ? foldLines(content) : content.join('\n')
    if (content.length === 0) return ''
    if (chomp === '+') text += '\n'.repeat(trailing + 1)
    else if (chomp === '') text += '\n'
    return text
  }

  const value = parseNode(0)
  skipBlank()
  if (index < lines.length) fail('unexpected content')
  return value ?? {}
}

function isSequenceItem(text) {
  return text === '-' || text.startsWith('- ')
}

/** [key, rest] for "key: rest" or "key:", or null. Keys are plain or quoted scalars. */
function splitKey(text) {
  const quoted = /^(["'])(.*?)\1:(?:\s+(.*)|$)/.exec(text)
  if (quoted) return [quoted[2], (quoted[3] ?? '').trim()]
  const plain = /^([^\s"'#\-[{][^:#]*?|-[^\s:#][^:#]*?):(?:\s+(.*)|$)/.exec(text)
  if (!plain) return null
  return [plain[1].trim(), (plain[2] ?? '').trim()]
}

/** YAML's line folding for > scalars: lines join with a space, an empty line keeps a newline. */
function foldLines(lines) {
  let text = ''
  let pendingBreaks = 0
  for (const line of lines) {
    if (line === '') {
      pendingBreaks++
      continue
    }
    if (text !== '') text += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' '
    pendingBreaks = 0
    text += line
  }
  return text
}

/** A scalar, quoted scalar, or flow collection written on one line (comments removed). */
function parseInline(raw, at) {
  const fail = (message) => {
    throw new Error(`YAML line ${at + 1}: ${message}`)
  }
  const text = raw.trim()
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]
    let out = ''
    let i = 1
    for (; i < text.length; i++) {
      const ch = text[i]
      if (quote === "'" && ch === "'" && text[i + 1] === "'") {
        out += "'"
        i++
      } else if (quote === '"' && ch === '\\') {
        const escapes = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', 0: '\0' }
        const next = text[++i]
        if (!(next in escapes)) fail(`unsupported escape \\${next}`)
        out += escapes[next]
      } else if (ch === quote) break
      else out += ch
    }
    if (i >= text.length) fail('unterminated quoted string')
    const rest = text.slice(i + 1).trim()
    if (rest !== '' && !rest.startsWith('#'))
      fail(`unexpected text after the quoted string: ${rest}`)
    return out
  }
  const plain = stripComment(text)
  if (plain.startsWith('[')) {
    if (!plain.endsWith(']')) fail('unterminated flow sequence')
    const inner = plain.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseInline(item, at))
  }
  if (plain.startsWith('{')) {
    if (!plain.endsWith('}')) fail('unterminated flow mapping')
    const inner = plain.slice(1, -1).trim()
    const map = {}
    if (inner === '') return map
    for (const part of inner.split(',')) {
      const pair = splitKey(part.trim())
      if (pair === null) fail(`expected "key: value" in a flow mapping, found ${part.trim()}`)
      map[pair[0]] = parseInline(pair[1], at)
    }
    return map
  }
  if (plain === 'true') return true
  if (plain === 'false') return false
  if (plain === 'null' || plain === '~' || plain === '') return null
  if (/^-?\d+$/.test(plain)) return Number(plain)
  return plain
}

/** A plain scalar without its trailing comment ("#" after whitespace starts one). */
function stripComment(text) {
  const match = /(^|\s)#/.exec(text)
  return (match ? text.slice(0, match.index) : text).trim()
}

// ---------------------------------------------------------------------------------------------
// The plan: which jobs and steps run here, and why the others don't.
// ---------------------------------------------------------------------------------------------

/** Steps that never run here, by their command, each with the reason the plan prints. */
export const SKIP_STEPS = [
  {
    match: /^npm ci(?: --ignore-scripts)?$/,
    reason:
      'not run here: app/node_modules is already installed (and may be shared with another checkout)'
  },
  {
    match: /^brew install ffmpeg$/,
    reason: "not run here: Homebrew's FFmpeg on this Mac is passed as MERGELANE_E2E_FIXTURE_FFMPEG"
  },
  {
    match: /^sudo ifconfig lo0 alias 127\.0\.0\.2\/32 && sudo ifconfig lo0 alias 127\.0\.0\.3\/32$/,
    reason:
      'needs root: without the two loopback aliases, the SOCKS and probe tests that need them skip themselves'
  }
]

/** Actions a step may use, each replaced by something already on this Mac. */
export const KNOWN_ACTIONS = [
  { match: /^actions\/checkout@/, reason: 'this checkout is used as it is' },
  { match: /^actions\/setup-node@/, reason: 'the Node.js on PATH is used' },
  { match: /^actions\/setup-go@/, reason: 'the Go on PATH is used' },
  {
    match: /^actions\/cache@/,
    reason: 'app/resources/bin stays between runs; fetch.mjs skips what is already right'
  },
  {
    match: /^actions\/upload-artifact@/,
    reason: 'files stay where the job left them; the logs are in the run folder'
  }
]

/** A command that needs root, or the simulated networks (which use sudo inside). */
export function needsRoot(command) {
  return (
    /(^|[\s;&|(])sudo\s/.test(command) || /scripts\/netsim\/(with-netsim|netsim)\.sh/.test(command)
  )
}

const CONDITIONS = new Set(['success()', 'failure()', 'always()'])

/**
 * The plan for a parsed workflow: every job, either runnable here (with its steps) or left to the
 * root runner, in the workflow's order. Throws a UsageError for a step no rule covers.
 */
export function planWorkflow(workflow) {
  const jobs = workflow?.jobs
  if (jobs === null || typeof jobs !== 'object' || Object.keys(jobs).length === 0) {
    throw new UsageError('the workflow has no jobs')
  }
  const workflowEnv = workflow.env ?? {}
  const workflowDefaults = workflow.defaults?.run ?? {}
  return Object.entries(jobs).map(([id, job]) => {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    const defaults = { ...workflowDefaults, ...(job?.defaults?.run ?? {}) }
    const timeoutMinutes = Number(job?.['timeout-minutes'] ?? DEFAULT_TIMEOUT_MINUTES)
    const planned = steps.map((step, i) => planStep(id, i, step, defaults))
    const root = planned.filter((step) => step.kind === 'root')
    return {
      id,
      timeoutMinutes,
      env: { ...workflowEnv, ...(job?.env ?? {}) },
      local: root.length === 0,
      rootReason:
        root.length === 0
          ? null
          : `needs root (${root.map((step) => step.name).join('; ')}): run scripts/ci/local-root.sh`,
      steps: planned
    }
  })
}

function planStep(job, index, step, defaults) {
  const name = step?.name ?? (step?.run ? String(step.run).split('\n')[0] : step?.uses) ?? '(step)'
  const base = { job, index, name }
  if (typeof step?.uses === 'string') {
    if (step.run !== undefined) throw new UsageError(`${job}: step "${name}" has both uses and run`)
    const known = KNOWN_ACTIONS.find(({ match }) => match.test(step.uses))
    if (!known) {
      throw new UsageError(
        `${job}: step "${name}" uses ${step.uses}, which local.mjs has no rule for: add one to KNOWN_ACTIONS`
      )
    }
    return { ...base, kind: 'action', reason: known.reason }
  }
  if (typeof step?.run !== 'string') {
    throw new UsageError(`${job}: step "${name}" has neither uses nor run`)
  }
  const command = step.run.trim()
  const condition = step.if === undefined ? 'success()' : String(step.if).trim()
  if (!CONDITIONS.has(condition)) {
    throw new UsageError(
      `${job}: step "${name}" has a condition local.mjs can't evaluate: ${condition}`
    )
  }
  const skip = SKIP_STEPS.find(({ match }) => match.test(command))
  if (skip) return { ...base, kind: 'skip', command, reason: skip.reason }
  if (needsRoot(command)) return { ...base, kind: 'root', command, condition }
  if (command.includes('${{')) {
    throw new UsageError(
      `${job}: step "${name}" uses a \${{ }} expression, which local.mjs can't evaluate`
    )
  }
  const shell = step.shell ?? defaults.shell ?? null
  if (shell !== null && shell !== 'bash') {
    throw new UsageError(`${job}: step "${name}" uses shell ${shell}; only bash is supported`)
  }
  return {
    ...base,
    kind: 'run',
    command,
    condition,
    workingDirectory: step['working-directory'] ?? defaults['working-directory'] ?? '.',
    // GitHub's docs: unspecified runs `bash -e {0}`; `bash` runs `bash --noprofile --norc -eo pipefail {0}`.
    shellArgs: shell === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail'] : ['-e'],
    env: step.env ?? {}
  }
}

/** The jobs to run, in the workflow's order: all local ones, or the ones named. */
export function selectJobs(plan, names = []) {
  if (names.length === 0) return plan.filter((job) => job.local)
  const byId = new Map(plan.map((job) => [job.id, job]))
  for (const name of names) {
    const job = byId.get(name)
    if (!job) {
      const known = plan.map(({ id }) => id).join(', ')
      throw new UsageError(`there is no job "${name}" in the workflow; the jobs are: ${known}`)
    }
    if (!job.local) throw new UsageError(`${name} ${job.rootReason}`)
  }
  return plan.filter((job) => names.includes(job.id))
}

/** The plan as text, for --list and --dry-run. */
export function describePlan(plan) {
  const out = []
  for (const job of plan) {
    out.push(
      job.local ? `${job.id} (timeout ${job.timeoutMinutes} min)` : `${job.id}: ${job.rootReason}`
    )
    if (!job.local) continue
    for (const step of job.steps) {
      if (step.kind === 'run') {
        const where = step.workingDirectory === '.' ? '' : ` [in ${step.workingDirectory}]`
        const when = step.condition === 'success()' ? '' : ` [if ${step.condition}]`
        out.push(`  run   ${step.name}${where}${when}`)
      } else {
        out.push(`  skip  ${step.name}: ${step.reason}`)
      }
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Reading results out of the logs.
// ---------------------------------------------------------------------------------------------

const sumMatches = (text, pattern) =>
  [...text.matchAll(pattern)].reduce((total, match) => total + Number(match[1]), 0)

/** Counts and coverage from `node --test` output (spec or TAP reporter). */
export function parseNodeTest(text) {
  const counts = {
    passed: sumMatches(text, /^[ℹ#] pass (\d+)$/gm),
    failed: sumMatches(text, /^[ℹ#] fail (\d+)$/gm) + sumMatches(text, /^[ℹ#] cancelled (\d+)$/gm),
    skipped: sumMatches(text, /^[ℹ#] skipped (\d+)$/gm) + sumMatches(text, /^[ℹ#] todo (\d+)$/gm)
  }
  const coverage = []
  // One table row per file: "ℹ   notes.mjs |  99.50 |    99.15 |  100.00 | 391-392".
  const row =
    /^[ℹ#][ \t]+(\S[^|\n]*?)[ \t]*\|[ \t]*([\d.]+)[ \t]*\|[ \t]*([\d.]+)[ \t]*\|[ \t]*([\d.]+)[ \t]*\|/gm
  for (const match of text.matchAll(row)) {
    const file = match[1].trim()
    if (file === 'all files' || /\.test\.m?js$/.test(file)) continue
    coverage.push({ label: file, lines: Number(match[2]) })
  }
  return { counts, coverage }
}

/** Counts from scripts/ci/check-repo.test.sh ("check-repo tests: 18 passed, 0 failed"). */
export function parseShellTests(text) {
  const match = /(\d+) passed, (\d+) failed/.exec(text)
  return {
    counts: match ? { passed: Number(match[1]), failed: Number(match[2]), skipped: 0 } : null,
    coverage: []
  }
}

/** Counts from Playwright's list reporter summary. A flaky test (passed only on a retry) counts as
 * failed: the suite runs with no retries because a retry would hide a race. */
export function parsePlaywright(text) {
  const count = (words) => sumMatches(text, new RegExp(`^\\s*(\\d+) ${words}\\b`, 'gm'))
  if (!/^\s*\d+ (passed|failed|skipped|flaky|interrupted|did not run)\b/m.test(text)) {
    return { counts: null, coverage: [] }
  }
  return {
    counts: {
      passed: count('passed'),
      failed: count('failed') + count('flaky') + count('interrupted') + count('did not run'),
      skipped: count('skipped')
    },
    coverage: []
  }
}

/** Counts from Vitest's summary line ("Tests  1 failed | 11 passed | 2 skipped (14)"). Its per-file
 * coverage is not read: the text table leaves out some fully covered files, and the 90% floor is
 * enforced by Vitest's own thresholds, which fail the run (vitest.config.ts). */
export function parseVitest(text) {
  const line = /^\s*Tests\s+(.+)\(\d+\)\s*$/m.exec(text)
  if (!line) return { counts: null, coverage: [] }
  const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(line[1])?.[1] ?? 0)
  return {
    counts: {
      passed: count('passed'),
      failed: count('failed'),
      skipped: count('skipped') + count('todo')
    },
    coverage: []
  }
}

/** Counts from `go test -v` (top-level tests and subtests) and the packages' coverage. */
export function parseGoTest(text) {
  const packagesOk = (text.match(/^ok\s+\S+/gm) ?? []).length
  const packagesFailed = (text.match(/^FAIL\s+\S+/gm) ?? []).length
  return {
    counts: {
      passed: (text.match(/^\s*--- PASS:/gm) ?? []).length,
      failed: (text.match(/^\s*--- FAIL:/gm) ?? []).length,
      skipped: (text.match(/^\s*--- SKIP:/gm) ?? []).length,
      packages: { ok: packagesOk, failed: packagesFailed }
    },
    coverage: []
  }
}

/** The total line of `go tool cover -func`. */
export function parseGoCoverTotal(text) {
  const match = /^total:\s+\(statements\)\s+([\d.]+)%/m.exec(text)
  return {
    counts: null,
    coverage: match ? [{ label: 'Go total (statements)', lines: Number(match[1]) }] : []
  }
}

/** The parser for a step's output, chosen by its command, or null when it reports no counts. */
export function parserFor(command) {
  if (/\bnode --test\b/.test(command)) return parseNodeTest
  if (/check-repo\.test\.sh/.test(command)) return parseShellTests
  if (/\bplaywright test\b|\btest:e2e/.test(command)) return parsePlaywright
  if (/\bvitest\b|\btest:unit/.test(command)) return parseVitest
  if (/\bgo test\b/.test(command)) return parseGoTest
  if (/\bgo tool cover\b/.test(command)) return parseGoCoverTotal
  return null
}

/** Adds one step's counts and coverage into a job's totals. */
export function addResult(total, result) {
  if (result === null) return total
  if (result.counts) {
    total.counts ??= { passed: 0, failed: 0, skipped: 0 }
    total.counts.passed += result.counts.passed
    total.counts.failed += result.counts.failed
    total.counts.skipped += result.counts.skipped
    if (result.counts.packages) {
      total.packages ??= { ok: 0, failed: 0 }
      total.packages.ok += result.counts.packages.ok
      total.packages.failed += result.counts.packages.failed
    }
  }
  total.coverage.push(...result.coverage)
  return total
}

// ---------------------------------------------------------------------------------------------
// The ~/Downloads guard.
// ---------------------------------------------------------------------------------------------

/** The names in a folder; an empty set when it doesn't exist. Throws when it can't be read. */
export function listEntries(dir) {
  try {
    return new Set(readdirSync(dir))
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw new Error(`cannot list ${dir} to guard it (${error.code ?? error.message})`)
  }
}

export function newEntries(before, after) {
  return [...after].filter((name) => !before.has(name)).sort()
}

// ---------------------------------------------------------------------------------------------
// Running.
// ---------------------------------------------------------------------------------------------

/** The environment every step gets: this one, plus what CI sets, minus ELECTRON_RUN_AS_NODE. */
export function baseEnv(source, { fixtureFfmpeg }) {
  const env = { ...source }
  delete env.ELECTRON_RUN_AS_NODE
  // Set by `node --test` for the processes it starts; a step's own `node --test` must report as usual.
  delete env.NODE_TEST_CONTEXT
  return {
    ...env,
    // GitHub's docs: "Always set to true" on its runners.
    CI: 'true',
    MERGELANE_E2E_FIXTURE_FFMPEG: fixtureFfmpeg,
    // package-test.sh's local mode (no quarantine, an isolated launch).
    MERGELANE_PACKAGE_TEST_LOCAL: '1'
  }
}

/** What a step's environment adds: `go test` runs verbose (GOFLAGS=-v), so the table can count
 * every test, and uncached (-count=1), as on CI's fresh runner. The command stays as ci.yml has it. */
export function stepExtraEnv(command, env) {
  if (!/\bgo test\b/.test(command)) return {}
  return { GOFLAGS: [env.GOFLAGS, '-v', '-count=1'].filter(Boolean).join(' ') }
}

/** Runs one script with bash in its own process group. Resolves to { code, output, timedOut }. */
export function runScript({ script, shellArgs, cwd, env, timeoutMs, log, scriptFile }) {
  writeFileSync(scriptFile, `${script}\n`)
  return new Promise((resolvePromise) => {
    const child = spawn('bash', [...shellArgs, scriptFile], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const chunks = []
    const take = (chunk) => {
      chunks.push(chunk)
      log.write(chunk)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    let timedOut = false
    let killer = null
    const timer = setTimeout(() => {
      timedOut = true
      signalGroup(child.pid, 'SIGTERM')
      killer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    child.on('error', (error) => {
      take(Buffer.from(`local-ci: cannot start bash: ${error.message}\n`))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (killer) clearTimeout(killer)
      // A step that leaves a process behind in its group doesn't outlive the step.
      signalGroup(child.pid, 'SIGTERM')
      resolvePromise({
        code: code ?? (signal ? 128 : 1),
        output: Buffer.concat(chunks).toString('utf8'),
        timedOut
      })
    })
  })
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}

const formatDuration = (ms) => {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Runs one job's steps. Returns its result for the table. */
export async function runJob(job, options) {
  const { root, env, logDir, downloads, print, now = Date.now } = options
  const started = now()
  const deadline = started + job.timeoutMinutes * 60_000
  const logFile = join(logDir, `${job.id}.log`)
  const scripts = join(logDir, 'steps')
  mkdirSync(scripts, { recursive: true })
  const log = createWriteStream(logFile)
  const result = {
    id: job.id,
    status: 'PASS',
    notes: [],
    counts: null,
    packages: null,
    coverage: []
  }
  const before = listEntries(downloads)
  let failed = false

  for (const step of job.steps) {
    if (step.kind !== 'run') {
      log.write(
        `\n== ${step.name}: ${step.kind === 'action' ? 'action' : 'skipped'}, ${step.reason}\n`
      )
      continue
    }
    const runs =
      step.condition === 'always()' || (step.condition === 'failure()' ? failed : !failed)
    if (!runs) {
      log.write(`\n== ${step.name}: not run (${step.condition})\n`)
      continue
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      failed = true
      result.notes.push(`timed out before "${step.name}"`)
      break
    }
    print(`  ${job.id}: ${step.name}`)
    log.write(`\n== ${step.name}\n$ ${step.command.split('\n').join('\n$ ')}\n`)
    const outcome = await runScript({
      script: step.command,
      shellArgs: step.shellArgs,
      cwd: resolve(root, step.workingDirectory),
      env: {
        ...env,
        ...stringValues(job.env),
        ...stringValues(step.env),
        ...stepExtraEnv(step.command, env)
      },
      timeoutMs: remaining,
      log,
      scriptFile: join(scripts, `${job.id}-${step.index + 1}.sh`)
    })
    addResult(result, parserFor(step.command)?.(outcome.output) ?? null)
    if (outcome.timedOut) {
      failed = true
      result.notes.push(`"${step.name}" passed the job's ${job.timeoutMinutes}-minute timeout`)
      log.write(`\n== ${step.name}: timed out\n`)
    } else if (outcome.code !== 0) {
      failed = true
      result.notes.push(`"${step.name}" exited with ${outcome.code}`)
      log.write(`\n== ${step.name}: exit ${outcome.code}\n`)
    }
  }

  let appeared = []
  try {
    appeared = newEntries(before, listEntries(downloads))
  } catch (error) {
    appeared = [`(${error.message})`]
  }
  if (appeared.length > 0) {
    failed = true
    result.notes.push(`new in ${downloads}: ${appeared.join(', ')}`)
    log.write(`\n== new in ${downloads} during this job: ${appeared.join(', ')}\n`)
  }
  await new Promise((resolveClose) => log.end(resolveClose))
  result.status = failed ? 'FAIL' : 'PASS'
  result.duration = now() - started
  result.log = logFile
  return result
}

function stringValues(env) {
  return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, String(value)]))
}

/** The results as a table, one row per job, with the root-only jobs at the end. */
export function formatTable(results, rootJobs = []) {
  const rows = results.map((result) => {
    const counts = result.counts
      ? `${result.counts.passed} passed, ${result.counts.failed} failed, ${result.counts.skipped} skipped`
      : '-'
    const packages = result.packages
      ? ` (packages: ${result.packages.ok} ok, ${result.packages.failed} failed)`
      : ''
    const coverage =
      result.coverage.length === 0
        ? '-'
        : result.coverage.map(({ label, lines }) => `${label} ${lines.toFixed(1)}%`).join(', ')
    return [
      result.id,
      result.status,
      formatDuration(result.duration ?? 0),
      counts + packages,
      coverage
    ]
  })
  for (const job of rootJobs)
    rows.push([job.id, 'ROOT', '-', 'needs root: scripts/ci/local-root.sh', '-'])
  const header = ['Job', 'Result', 'Time', 'Tests', 'Coverage (lines)']
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length))
  )
  const line = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  const out = [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)]
  for (const result of results) {
    for (const note of result.notes) out.push(`${result.id}: ${note}`)
  }
  return out.join('\n')
}

/** Files a job makes that git doesn't ignore and nothing needs afterwards (the daemon job's
 * `go build -o mergelane-daemon` check). Removed after the job, unless they were there before. */
export const LEFTOVERS = ['daemon/mergelane-daemon']

function timestamp(date) {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[:T]/g, '-')
}

function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        job: { type: 'string', multiple: true },
        'keep-going': { type: 'boolean' },
        list: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        logs: { type: 'string' },
        downloads: { type: 'string' },
        'fixture-ffmpeg': { type: 'string' },
        workflow: { type: 'string' },
        root: { type: 'string' },
        help: { type: 'boolean' }
      }
    })
  } catch (error) {
    throw new UsageError(error.message)
  }
  const values = parsed.values
  return {
    jobs: (values.job ?? [])
      .flatMap((name) => name.split(','))
      .map((name) => name.trim())
      .filter(Boolean),
    keepGoing: Boolean(values['keep-going']),
    list: Boolean(values.list),
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
    logRoot: resolve(values.logs ?? DEFAULT_LOG_ROOT),
    downloads: resolve(values.downloads ?? join(homedir(), 'Downloads')),
    fixtureFfmpeg: values['fixture-ffmpeg'] ?? DEFAULT_FIXTURE_FFMPEG,
    workflow: resolve(values.workflow ?? DEFAULT_WORKFLOW),
    root: resolve(values.root ?? ROOT)
  }
}

/** CLI entry point. Resolves to the exit code. */
export async function main(
  argv = process.argv.slice(2),
  { print = console.log, error = console.error, env = process.env, now = Date.now } = {}
) {
  let options
  let plan
  let selected
  try {
    options = parseCli(argv)
    if (options.help) {
      print(USAGE)
      return 0
    }
    let text
    try {
      text = readFileSync(options.workflow, 'utf8')
    } catch (failure) {
      throw new UsageError(`cannot read the workflow ${options.workflow}: ${failure.message}`)
    }
    let workflow
    try {
      workflow = parseYaml(text)
    } catch (failure) {
      throw new UsageError(`cannot read the workflow ${options.workflow}: ${failure.message}`)
    }
    plan = planWorkflow(workflow)
    if (options.list) {
      print(describePlan(plan))
      return 0
    }
    selected = selectJobs(plan, options.jobs)
    if (options.dryRun) {
      print(describePlan(selected))
      return 0
    }
    const needsFixture = selected.some((job) =>
      job.steps.some((step) => step.kind === 'skip' && /brew install ffmpeg/.test(step.command))
    )
    if (needsFixture) {
      try {
        accessSync(options.fixtureFfmpeg, constants.X_OK)
      } catch {
        throw new UsageError(
          `the e2e suite needs a full FFmpeg for its sample media: ${options.fixtureFfmpeg} is not there (brew install ffmpeg, or --fixture-ffmpeg <path>)`
        )
      }
    }
    // Fails before anything runs when ~/Downloads can't be listed: the guard must work.
    listEntries(options.downloads)
  } catch (failure) {
    error(`local-ci: ${failure.message}`)
    if (failure instanceof UsageError) {
      error(USAGE)
      return 2
    }
    return 1
  }

  const logDir = join(options.logRoot, timestamp(new Date(now())))
  mkdirSync(logDir, { recursive: true })
  const stepEnv = baseEnv(env, { fixtureFfmpeg: options.fixtureFfmpeg })
  print(`local-ci: logs in ${logDir}`)
  const results = []
  let failed = false
  for (const job of selected) {
    if (failed && !options.keepGoing) {
      results.push({
        id: job.id,
        status: 'NOT RUN',
        notes: [],
        counts: null,
        coverage: [],
        duration: 0
      })
      continue
    }
    print(`local-ci: ${job.id}`)
    const leftovers = LEFTOVERS.filter((path) => !existsSync(join(options.root, path)))
    const result = await runJob(job, {
      root: options.root,
      env: stepEnv,
      logDir,
      downloads: options.downloads,
      print,
      now
    })
    // A CI runner is thrown away after each job; here, outputs no one asked to keep go.
    for (const path of leftovers) rmSync(join(options.root, path), { force: true, recursive: true })
    print(
      `local-ci: ${job.id} ${result.status} (${formatDuration(result.duration)}), log: ${result.log}`
    )
    results.push(result)
    if (result.status === 'FAIL') failed = true
  }
  const table = formatTable(
    results,
    plan.filter((job) => !job.local)
  )
  writeFileSync(join(logDir, 'summary.txt'), `${table}\n`)
  print('')
  print(table)
  print('')
  print(`local-ci: ${failed ? 'FAIL' : 'PASS'} (summary: ${join(logDir, 'summary.txt')})`)
  return failed ? 1 : 0
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
