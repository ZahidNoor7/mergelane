#!/usr/bin/env node
// Reads the report the Windows test kit writes on the owner's laptop (scripts/windows/test-kit.ps1), as the owner
// pastes it back, and says in plain words what it shows (ADR-0054, docs/WINDOWS-TESTING.md). The report is JSON
// between two marker lines, so text around it (a chat message, the kit's own summary) doesn't matter.
//
// usage: node scripts/windows/report.mjs [<file>]      (reads standard input when no file is given)
// Exit codes: 0 everything that must pass passed and Downloads didn't change; 1 something failed;
// 2 no readable report.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BEGIN = '-----BEGIN MERGELANE TEST KIT REPORT-----'
export const END = '-----END MERGELANE TEST KIT REPORT-----'
export const REPORT_VERSION = 1

/** The module path coverage lines start with; dropped when files are named. */
export const MODULE = 'github.com/ZahidNoor7/mergelane/daemon/'

export class ReportError extends Error {}

/** The report object from pasted text. */
export function extractReport(text) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END, start + 1)
  if (start === -1 || end === -1) {
    throw new ReportError('no report found: copy everything from the BEGIN line to the END line')
  }
  let report
  try {
    report = JSON.parse(text.slice(start + BEGIN.length, end))
  } catch (error) {
    throw new ReportError(`the report's JSON is damaged (${error.message}); copy it again from report.txt`)
  }
  if (report?.report !== REPORT_VERSION) {
    throw new ReportError(`report version ${report?.report} isn't ${REPORT_VERSION}; rebuild the kit`)
  }
  return report
}

/**
 * Per-file statement coverage from Go coverage profile lines ("file.go:12.3,14.2 2 1": a block, its statement
 * count and how often it ran). A block seen in several profiles counts as covered if any of them ran it.
 */
export function coverageByFile(lines) {
  const blocks = new Map()
  for (const line of lines) {
    const match = /^(.+\.go):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line.trim())
    if (!match) continue
    const [, file, span, statements, count] = match
    const key = `${file}:${span}`
    const seen = blocks.get(key)
    blocks.set(key, {
      file,
      statements: Number(statements),
      covered: Boolean(seen?.covered) || Number(count) > 0
    })
  }
  const files = new Map()
  for (const { file, statements, covered } of blocks.values()) {
    const name = file.startsWith(MODULE) ? file.slice(MODULE.length) : file
    const entry = files.get(name) ?? { file: name, statements: 0, covered: 0 }
    entry.statements += statements
    if (covered) entry.covered += statements
    files.set(name, entry)
  }
  return [...files.values()]
    .map((entry) => ({
      ...entry,
      percent: entry.statements ? Math.round((entry.covered / entry.statements) * 1000) / 10 : 100
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** "must": a failure fails the run. "not yet": it may fail until its milestone. "info": skipped. */
export function programVerdict(program) {
  if (program.status === 'passed') return 'passed'
  if (program.status === 'skipped') return 'info'
  return program.until ? 'not yet' : 'must'
}

/** An app check: "passed" when its window opened, "info" when this PC's chip can't run it, else "must". */
export function appVerdict(app) {
  if (app.status === 'ready') return 'passed'
  if (app.status === 'skipped') return 'info'
  return 'must'
}

export function describeApp(app) {
  const head = `${String(app.arch).padEnd(5)} Mergelane`
  if (app.status === 'skipped') return `${head}: skipped, ${app.reason}`
  if (app.status === 'error') return `${head}: could not start: ${app.reason}`
  const stopped = app.leftRunning ? `; ${app.leftRunning} of its processes had to be stopped afterwards` : ''
  if (app.status === 'ready') {
    const bridge = app.bridge === 'ready' ? ', the browser bridge answered' : ''
    return `${head}: window opened after ${app.seconds} s${bridge}, then closed${stopped}`
  }
  return `${head}: FAILED after ${app.seconds} s: ${app.reason}${stopped}`
}

const SMART_APP_CONTROL = {
  off: 'Off',
  evaluation: 'Evaluation (it watches, and may switch itself On or Off later)',
  on: 'On: Windows blocks unsigned apps such as these builds, with no way round it',
  absent: 'not on this Windows (Windows 10 has none)'
}

function describeProgram(program) {
  const head = `${program.arch.padEnd(5)} ${program.package}`
  if (program.status === 'skipped') return `${head}: skipped, ${program.reason}`
  if (program.status === 'error') {
    const later = program.until ? ` (expected before ${program.until})` : ''
    return `${head}: could not run${later}: ${program.reason}`
  }
  const counts = `${program.passed} passed, ${program.failed} failed, ${program.skippedTests} skipped`
  const coverage = typeof program.coverage === 'number' ? `, coverage ${program.coverage}%` : ''
  if (program.status === 'passed') return `${head}: passed (${counts}${coverage})`
  const later = program.until ? ` (expected before ${program.until})` : ''
  const which = program.failedTests?.length ? `: ${program.failedTests.join(', ')}` : ''
  return `${head}: failed${later} (${counts}${coverage})${which}`
}

/** The report in plain words, and whether it is a pass. */
export function summarize(report) {
  const lines = []
  const { windows = {}, chip = {}, kit = {} } = report
  const version = windows.error
    ? `Windows (unreadable: ${windows.error})`
    : `${windows.caption} (build ${windows.build})`
  lines.push(`${version}, ${chip.arch ?? 'unknown'} chip${chip.name ? ` (${chip.name})` : ''}.`)
  lines.push(`Smart App Control: ${SMART_APP_CONTROL[report.smartAppControl] ?? report.smartAppControl}.`)
  lines.push(
    `Kit from commit ${kit.commit}${kit.dirty ? ' (with uncommitted changes)' : ''}, built ${String(kit.built).slice(0, 10)}; ran ${String(report.ran).slice(0, 10)}.`
  )
  lines.push(
    `Windows PowerShell ${report.powershell}, execution policy ${report.executionPolicy}; kit marked as downloaded: ${report.markOfTheWeb ? 'yes' : 'no'}.`
  )

  let ok = true
  const downloads = report.downloads ?? {}
  if (!downloads.checked) {
    ok = false
    lines.push(`Downloads folder: not checked (${downloads.error ?? 'no result'}).`)
  } else {
    const changes = ['added', 'removed', 'changed'].flatMap((kind) =>
      (downloads[kind] ?? []).map((name) => `${kind}: ${name}`)
    )
    if (changes.length === 0) lines.push('Downloads folder: unchanged.')
    else {
      ok = false
      lines.push('Downloads folder CHANGED while the kit ran (tests must never write there):')
      for (const change of changes) lines.push(`  ${change}`)
    }
  }

  const programs = report.programs ?? []
  lines.push(programs.length ? 'Go test programs:' : 'Go test programs: none in this kit.')
  for (const program of programs) {
    lines.push(`  ${describeProgram(program)}`)
    if (programVerdict(program) === 'must') ok = false
  }

  const apps = report.apps ?? []
  if (apps.length) lines.push('Mergelane opened from the kit:')
  for (const app of apps) {
    lines.push(`  ${describeApp(app)}`)
    if (appVerdict(app) === 'must') ok = false
  }

  const coverage = coverageByFile(programs.flatMap((program) => program.cover ?? []))
  if (coverage.length) {
    lines.push('Coverage of Windows-only files:')
    for (const file of coverage) {
      lines.push(`  ${file.file}: ${file.covered} of ${file.statements} statements (${file.percent}%)`)
    }
  }

  lines.push(ok ? 'Result: PASS' : 'Result: FAIL')
  return { ok, lines, coverage }
}

async function readAll(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

export async function main(
  argv = process.argv.slice(2),
  { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}
) {
  if (argv.length > 1) {
    stderr.write('usage: node scripts/windows/report.mjs [<file>]\n')
    return 2
  }
  try {
    const text = argv.length ? readFileSync(argv[0], 'utf8') : await readAll(stdin)
    const { ok, lines } = summarize(extractReport(text))
    stdout.write(`${lines.join('\n')}\n`)
    return ok ? 0 : 1
  } catch (error) {
    stderr.write(`report: ${error.message}\n`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
