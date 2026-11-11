// Tests for audit-fuses.mjs. Run: node --test scripts/ci/audit-fuses.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkFuses, EXPECTED_FUSES, main, REA, runRea } from './audit-fuses.mjs'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const hardenedPath = join(fixtures, 'rea-fuses-hardened.json')
const defaultsPath = join(fixtures, 'rea-fuses-electron-defaults.json')
const load = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Runs fn with console.log/error captured, returning [result, output lines]. */
function capture(fn) {
  const lines = []
  const { log, error } = console
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    return [fn(), lines]
  } finally {
    console.log = log
    console.error = error
  }
}

test('the hardened build passes', () => {
  assert.deepEqual(checkFuses(load(hardenedPath)), [])
})

test("Electron's default fuses fail, naming each wrong fuse", () => {
  const problems = checkFuses(load(defaultsPath))
  assert.equal(problems.length, Object.keys(EXPECTED_FUSES).length)
  assert.ok(problems.some((p) => p.includes('RunAsNode is enabled, expected disabled')))
  assert.ok(problems.some((p) => p.includes('OnlyLoadAppFromAsar is disabled, expected enabled')))
})

test('missing evidence or slices means the fuse state is unknown', () => {
  for (const evidence of [undefined, {}, { normalized_result: { slices: [] } }]) {
    assert.deepEqual(checkFuses(evidence), [
      'REA evidence has no Mach-O slices: the fuse state is unknown'
    ])
  }
})

test('zero or several sentinels in a slice are rejected', () => {
  const evidence = load(hardenedPath)
  const [slice] = evidence.normalized_result.slices
  const none = { normalized_result: { slices: [{ ...slice, sentinels: [] }] } }
  assert.match(checkFuses(none)[0], /expected 1 fuse sentinel, found 0/)
  const two = { normalized_result: { slices: [{ ...slice, sentinels: [slice.sentinels[0], slice.sentinels[0]] }] } }
  assert.match(checkFuses(two)[0], /expected 1 fuse sentinel, found 2/)
  const missing = { normalized_result: { slices: [{ architecture: 'arm64' }] } }
  assert.match(checkFuses(missing)[0], /found 0/)
})

test('an incomplete fuse wire and a missing fuse are reported', () => {
  const evidence = load(hardenedPath)
  const sentinel = evidence.normalized_result.slices[0].sentinels[0]
  sentinel.complete = false
  sentinel.fuses = sentinel.fuses.filter((fuse) => fuse.name !== 'RunAsNode')
  const problems = checkFuses(evidence)
  assert.ok(problems.includes('slice arm64: fuse wire is incomplete'))
  assert.ok(problems.includes('slice arm64: RunAsNode is missing, expected disabled'))
})

test('a sentinel without a fuse list reports every expected fuse as missing', () => {
  const evidence = load(hardenedPath)
  delete evidence.normalized_result.slices[0].sentinels[0].fuses
  assert.equal(checkFuses(evidence).length, Object.keys(EXPECTED_FUSES).length)
})

test('main: saved hardened evidence exits 0 and prints the fuses', () => {
  const [code, lines] = capture(() => main(['Mergelane.app', hardenedPath]))
  assert.equal(code, 0)
  assert.ok(lines.includes('audit-fuses: PASS'))
  assert.ok(lines.some((line) => /RunAsNode\s+disabled/.test(line)))
})

test('main: saved default evidence exits 1 with each failure', () => {
  const [code, lines] = capture(() => main(['Mergelane.app', defaultsPath]))
  assert.equal(code, 1)
  assert.equal(lines.filter((line) => line.startsWith('audit-fuses: FAIL')).length, 6)
})

test('main: no arguments prints usage and exits 2', () => {
  const [code, lines] = capture(() => main([]))
  assert.equal(code, 2)
  assert.match(lines[0], /^usage:/)
})

test('runRea calls the pinned REA package and parses its JSON', () => {
  const calls = []
  const fakeExec = (cmd, args, options) => {
    calls.push({ cmd, args, options })
    return readFileSync(hardenedPath, 'utf8')
  }
  const evidence = runRea('/Applications/Mergelane.app', fakeExec)
  assert.deepEqual(checkFuses(evidence), [])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'npx')
  assert.deepEqual(calls[0].args, [
    '-y',
    REA,
    'inspect-electron-fuses',
    '/Applications/Mergelane.app',
    '--format',
    'json'
  ])
  assert.equal(calls[0].options.encoding, 'utf8')
})

test('main without saved evidence runs REA', () => {
  const fakeExec = () => readFileSync(defaultsPath, 'utf8')
  const [code] = capture(() => main(['Mergelane.app'], fakeExec))
  assert.equal(code, 1)
})

test('the script runs from the command line and sets its exit code', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'audit-fuses.mjs')
  const pass = spawnSync(process.execPath, [script, 'Mergelane.app', hardenedPath], { encoding: 'utf8' })
  assert.equal(pass.status, 0)
  assert.match(pass.stdout, /audit-fuses: PASS/)
  const failed = spawnSync(process.execPath, [script, 'Mergelane.app', defaultsPath], { encoding: 'utf8' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /RunAsNode is enabled, expected disabled/)
})
