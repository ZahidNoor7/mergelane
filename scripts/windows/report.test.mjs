// Tests for reading the Windows test kit's report. The reports here are made up in the format test-kit.ps1 writes;
// real ones from the owner's laptop join them as they arrive. Run: node --test --experimental-test-coverage
// --test-coverage-include='scripts/windows/report.mjs' scripts/windows/report.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import {
  BEGIN,
  END,
  MODULE,
  REPORT_VERSION,
  ReportError,
  appVerdict,
  coverageByFile,
  describeApp,
  extractReport,
  main,
  programVerdict,
  summarize
} from './report.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'mergelane-report-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function program(overrides = {}) {
  return {
    id: 'x64/internal/nmhost',
    arch: 'x64',
    package: 'internal/nmhost',
    until: null,
    status: 'passed',
    exitCode: 0,
    seconds: 1.4,
    passed: 30,
    failed: 0,
    skippedTests: 1,
    failedTests: [],
    coverage: 91.7,
    tail: [],
    cover: [],
    ...overrides
  }
}

function report(overrides = {}) {
  return {
    report: REPORT_VERSION,
    kit: { commit: 'abc1234', dirty: false, built: '2026-11-12T10:00:00.000Z' },
    ran: '2026-11-13T08:30:00.0000000Z',
    windows: { caption: 'Microsoft Windows 11 Home', version: '10.0.26100', build: 26100 },
    chip: { arch: 'x64', code: 9, name: 'Intel(R) Core(TM) i5-1135G7 @ 2.40GHz' },
    powershell: '5.1.26100.2161',
    executionPolicy: 'Bypass',
    smartAppControl: 'off',
    markOfTheWeb: true,
    downloads: { checked: true, added: [], removed: [], changed: [] },
    programs: [program()],
    ...overrides
  }
}

/** As the owner pastes it: the kit's summary lines, then the JSON between the markers (CRLF, like the kit). */
function pasted(object) {
  return [
    'Mergelane Windows test kit report',
    'Test programs passed: 1 of 1',
    '',
    BEGIN,
    JSON.stringify(object, null, 4),
    END,
    ''
  ].join('\r\n')
}

function capture() {
  const stream = new PassThrough()
  let text = ''
  stream.on('data', (chunk) => (text += chunk))
  return { stream, text: () => text }
}

describe('extractReport', () => {
  it('finds the JSON between the markers, whatever surrounds it', () => {
    const text = `Here is the report:\n${pasted(report())}\nthanks`
    assert.equal(extractReport(text).chip.arch, 'x64')
  })

  it('says what to do when the markers are missing, the JSON is damaged or the version differs', () => {
    assert.throws(() => extractReport('nothing here'), ReportError)
    assert.throws(() => extractReport(`${BEGIN}\n{}`), /no report found/)
    assert.throws(() => extractReport(`${BEGIN}\n{"report": 1,\n${END}`), /JSON is damaged/)
    assert.throws(() => extractReport(pasted({ ...report(), report: 2 })), /report version 2 isn't 1/)
    assert.throws(() => extractReport(`${BEGIN}\nnull\n${END}`), /report version undefined/)
  })
})

describe('coverageByFile', () => {
  it('sums statements per file, counts a block covered if any profile ran it, and drops the module path', () => {
    const lines = [
      'mode: set',
      `${MODULE}internal/nics/info_windows.go:10.2,12.3 2 1`,
      `${MODULE}internal/nics/info_windows.go:14.2,16.3 3 0`,
      `${MODULE}internal/nics/info_windows.go:14.2,16.3 3 1`,
      `${MODULE}internal/nics/info_windows.go:18.2,19.3 5 0`,
      `${MODULE}internal/nics/egress_windows.go:5.1,9.2 4 1`,
      'example.com/other/thing_windows.go:1.1,2.2 1 0',
      'garbage line'
    ]
    assert.deepEqual(coverageByFile(lines), [
      { file: 'example.com/other/thing_windows.go', statements: 1, covered: 0, percent: 0 },
      { file: 'internal/nics/egress_windows.go', statements: 4, covered: 4, percent: 100 },
      { file: 'internal/nics/info_windows.go', statements: 10, covered: 5, percent: 50 }
    ])
  })

  it('treats a file with no statements as fully covered, and an empty profile as nothing', () => {
    assert.deepEqual(coverageByFile([`${MODULE}a_windows.go:1.1,1.2 0 0`]), [
      { file: 'a_windows.go', statements: 0, covered: 0, percent: 100 }
    ])
    assert.deepEqual(coverageByFile([]), [])
  })
})

describe('programVerdict', () => {
  it('passes, informs, allows "not yet" before the milestone, and otherwise must pass', () => {
    assert.equal(programVerdict(program()), 'passed')
    assert.equal(programVerdict(program({ status: 'skipped' })), 'info')
    assert.equal(programVerdict(program({ status: 'failed', until: 'W2' })), 'not yet')
    assert.equal(programVerdict(program({ status: 'error', until: 'W2' })), 'not yet')
    assert.equal(programVerdict(program({ status: 'failed' })), 'must')
    assert.equal(programVerdict(program({ status: 'error' })), 'must')
  })
})

describe('summarize', () => {
  it('reads a clean run in plain words', () => {
    const { ok, lines } = summarize(report())
    assert.equal(ok, true)
    assert.deepEqual(lines, [
      'Microsoft Windows 11 Home (build 26100), x64 chip (Intel(R) Core(TM) i5-1135G7 @ 2.40GHz).',
      'Smart App Control: Off.',
      'Kit from commit abc1234, built 2026-11-12; ran 2026-11-13.',
      'Windows PowerShell 5.1.26100.2161, execution policy Bypass; kit marked as downloaded: yes.',
      'Downloads folder: unchanged.',
      'Go test programs:',
      '  x64   internal/nmhost: passed (30 passed, 0 failed, 1 skipped, coverage 91.7%)',
      'Result: PASS'
    ])
  })

  it('fails when a program that must pass fails, and names the failed tests', () => {
    const { ok, lines } = summarize(
      report({
        programs: [
          program({ status: 'failed', exitCode: 1, passed: 28, failed: 2, failedTests: ['TestA', 'TestB/sub'] })
        ]
      })
    )
    assert.equal(ok, false)
    assert.ok(
      lines.includes(
        '  x64   internal/nmhost: failed (28 passed, 2 failed, 1 skipped, coverage 91.7%): TestA, TestB/sub'
      )
    )
    assert.equal(lines.at(-1), 'Result: FAIL')
  })

  it('accepts failures before their milestone, skipped chips, and programs that could not run yet', () => {
    const { ok, lines } = summarize(
      report({
        chip: { arch: 'x64', code: 9 },
        programs: [
          program({ status: 'failed', until: 'W2', failed: 1, failedTests: [], coverage: null }),
          program({
            id: 'arm64/internal/nmhost',
            arch: 'arm64',
            status: 'skipped',
            reason: "this PC (x64) can't run arm64 programs"
          }),
          program({ status: 'error', until: 'W2', reason: 'blocked' })
        ]
      })
    )
    assert.equal(ok, true)
    assert.equal(lines[0], 'Microsoft Windows 11 Home (build 26100), x64 chip.')
    assert.ok(lines.includes('  x64   internal/nmhost: failed (expected before W2) (30 passed, 1 failed, 1 skipped)'))
    assert.ok(lines.includes("  arm64 internal/nmhost: skipped, this PC (x64) can't run arm64 programs"))
    assert.ok(lines.includes('  x64   internal/nmhost: could not run (expected before W2): blocked'))
  })

  it('fails when a program that must pass could not run', () => {
    const { ok, lines } = summarize(
      report({
        programs: [program({ status: 'error', reason: 'An application control policy has blocked this file.' })]
      })
    )
    assert.equal(ok, false)
    assert.ok(
      lines.includes('  x64   internal/nmhost: could not run: An application control policy has blocked this file.')
    )
  })

  it('fails when anything in Downloads changed, and lists what', () => {
    const { ok, lines } = summarize(
      report({ downloads: { checked: true, added: ['test.bin'], removed: [], changed: ['folder'] } })
    )
    assert.equal(ok, false)
    assert.ok(lines.includes('Downloads folder CHANGED while the kit ran (tests must never write there):'))
    assert.ok(lines.includes('  added: test.bin'))
    assert.ok(lines.includes('  changed: folder'))
  })

  it('fails when Downloads could not be checked', () => {
    const missing = summarize(report({ downloads: undefined }))
    assert.equal(missing.ok, false)
    assert.ok(missing.lines.includes('Downloads folder: not checked (no result).'))
    const failed = summarize(report({ downloads: { checked: false, error: 'access denied' } }))
    assert.ok(failed.lines.includes('Downloads folder: not checked (access denied).'))
  })

  it('describes Smart App Control in each mode, and an unreadable Windows version', () => {
    const on = summarize(report({ smartAppControl: 'on' })).lines[1]
    assert.match(on, /On: Windows blocks unsigned apps/)
    assert.match(summarize(report({ smartAppControl: 'evaluation' })).lines[1], /Evaluation/)
    assert.match(summarize(report({ smartAppControl: 'absent' })).lines[1], /Windows 10 has none/)
    assert.equal(summarize(report({ smartAppControl: 'unknown (7)' })).lines[1], 'Smart App Control: unknown (7).')
    const lines = summarize(report({ windows: { error: 'WMI unavailable' }, chip: {}, markOfTheWeb: false })).lines
    assert.equal(lines[0], 'Windows (unreadable: WMI unavailable), unknown chip.')
    assert.match(lines[3], /kit marked as downloaded: no\.$/)
  })

  it('notes a kit built with uncommitted changes, an empty kit, and lists Windows-only coverage', () => {
    const empty = summarize(report({ kit: { commit: 'abc1234', dirty: true, built: '2026-11-12' }, programs: [] }))
    assert.match(empty.lines[2], /abc1234 \(with uncommitted changes\)/)
    assert.ok(empty.lines.includes('Go test programs: none in this kit.'))
    assert.equal(empty.ok, true)

    const covered = summarize(
      report({
        programs: [
          program({
            cover: [
              `${MODULE}internal/nics/info_windows.go:1.1,2.2 9 1`,
              `${MODULE}internal/nics/info_windows.go:3.1,4.2 1 0`
            ]
          }),
          program({ id: 'arm64/internal/nmhost', arch: 'arm64' })
        ]
      })
    )
    assert.ok(covered.lines.includes('Coverage of Windows-only files:'))
    assert.ok(covered.lines.includes('  internal/nics/info_windows.go: 9 of 10 statements (90%)'))
    assert.deepEqual(covered.coverage, [
      { file: 'internal/nics/info_windows.go', statements: 10, covered: 9, percent: 90 }
    ])
  })
})

describe('main', () => {
  it('reads a file, prints the summary and exits 0 for a pass', async () => {
    const file = join(scratch, 'report.txt')
    writeFileSync(file, pasted(report()))
    const stdout = capture()
    assert.equal(await main([file], { stdout: stdout.stream }), 0)
    assert.match(stdout.text(), /Result: PASS\n$/)
  })

  it('reads standard input and exits 1 for a fail', async () => {
    const stdout = capture()
    const stdin = Readable.from([pasted(report({ programs: [program({ status: 'failed' })] }))])
    assert.equal(await main([], { stdin, stdout: stdout.stream }), 1)
    assert.match(stdout.text(), /Result: FAIL/)
  })

  it('exits 2 for wrong usage, a missing file or no report', async () => {
    const stderr = capture()
    assert.equal(await main(['a', 'b'], { stderr: stderr.stream }), 2)
    assert.match(stderr.text(), /usage:/)
    const stderr2 = capture()
    assert.equal(await main([join(scratch, 'missing.txt')], { stderr: stderr2.stream }), 2)
    assert.match(stderr2.text(), /report: ENOENT/)
    const stderr3 = capture()
    assert.equal(await main([], { stdin: Readable.from(['hello']), stderr: stderr3.stream }), 2)
    assert.match(stderr3.text(), /no report found/)
  })
})

describe('the app check', () => {
  const app = (fields) => ({ arch: 'x64', kind: 'folder', ...fields })

  it('passes when the window opened, and says so', () => {
    const { ok, lines } = summarize(report({ apps: [app({ status: 'ready', seconds: 6.5, leftRunning: 0 })] }))
    assert.equal(ok, true)
    assert.ok(lines.includes('Mergelane opened from the kit:'))
    assert.ok(lines.includes('  x64   Mergelane: window opened after 6.5 s, then closed'))
    const bridged = summarize(report({ apps: [app({ status: 'ready', seconds: 7, bridge: 'ready', leftRunning: 0 })] }))
    assert.ok(bridged.lines.includes('  x64   Mergelane: window opened after 7 s, the browser bridge answered, then closed'))
  })

  it('fails when the window never opened or the app could not start, and notes stopped processes', () => {
    const failed = app({ status: 'failed', seconds: 90, reason: 'no window within 90 seconds', leftRunning: 3 })
    const { ok, lines } = summarize(report({ apps: [failed] }))
    assert.equal(ok, false)
    assert.ok(
      lines.includes(
        '  x64   Mergelane: FAILED after 90 s: no window within 90 seconds; 3 of its processes had to be stopped afterwards'
      )
    )
    assert.equal(describeApp(app({ status: 'error', reason: 'blocked' })), 'x64   Mergelane: could not start: blocked')
    assert.equal(appVerdict(app({ status: 'error' })), 'must')
  })

  it("doesn't count a chip this PC can't run", () => {
    const skipped = app({ arch: 'arm64', status: 'skipped', reason: "this PC (x64) can't run arm64 programs" })
    const { ok } = summarize(report({ apps: [skipped] }))
    assert.equal(ok, true)
    assert.equal(appVerdict(skipped), 'info')
    assert.equal(describeApp(skipped), "arm64 Mergelane: skipped, this PC (x64) can't run arm64 programs")
  })

  it('an installer: installed, opened and uninstalled cleanly, or what the uninstaller left', () => {
    const clean = app({ kind: 'installer', status: 'ready', installSeconds: 12.5, seconds: 6, bridge: 'ready', leftovers: [], leftRunning: 0 })
    assert.equal(
      describeApp(clean),
      'x64   Mergelane: installed in 12.5 s, window opened after 6 s, the browser bridge answered, uninstalled cleanly'
    )
    const messy = app({
      kind: 'installer',
      status: 'failed',
      installSeconds: 11,
      seconds: 6,
      bridge: 'ready',
      reason: 'the uninstaller left something behind',
      leftovers: ['a shortcut is left in Desktop'],
      leftRunning: 0
    })
    assert.equal(
      describeApp(messy),
      'x64   Mergelane: FAILED after 6 s: installed in 11 s, the uninstaller left something behind; after uninstalling: a shortcut is left in Desktop'
    )
    assert.equal(appVerdict(messy), 'must')
    const notInstalled = app({ kind: 'installer', status: 'failed', installSeconds: 3, reason: 'the installer ended with code 2 and Mergelane.exe is not in its folder' })
    assert.equal(
      describeApp(notInstalled),
      'x64   Mergelane: FAILED: installed in 3 s, the installer ended with code 2 and Mergelane.exe is not in its folder'
    )
    const already = app({ kind: 'installer', status: 'skipped', reason: 'Mergelane is already installed for you, so the kit does not install over it' })
    assert.equal(appVerdict(already), 'info')
  })

  it('says the helpers carry the app\'s version, or which one does not', () => {
    const good = app({
      kind: 'installer',
      status: 'ready',
      installSeconds: 9,
      seconds: 5,
      bridge: 'ready',
      version: '0.4.0',
      helpers: [],
      openWithMissing: [],
      leftovers: [],
      leftRunning: 0
    })
    assert.equal(
      describeApp(good),
      'x64   Mergelane: installed in 9 s, window opened after 5 s, the browser bridge answered, both helpers say 0.4.0, ' +
        'Open with lists it for .torrent and .nzb, uninstalled cleanly'
    )
    const noOpenWith = app({
      kind: 'installer',
      status: 'failed',
      installSeconds: 9,
      seconds: 5,
      bridge: 'ready',
      openWithMissing: ['.nzb'],
      reason: 'the installer did not add Mergelane to Open with for .nzb',
      leftovers: ['Open with still lists Mergelane for .torrent'],
      leftRunning: 0
    })
    assert.equal(
      describeApp(noOpenWith),
      'x64   Mergelane: FAILED after 5 s: installed in 9 s, the installer did not add Mergelane to Open with for .nzb; ' +
        'after uninstalling: Open with still lists Mergelane for .torrent'
    )
    const stale = app({
      kind: 'folder',
      status: 'failed',
      seconds: 5,
      bridge: 'ready',
      version: '0.4.0',
      helpers: ["mergelane-daemon.exe says 'mergelane-daemon dev', expected 'mergelane-daemon 0.4.0'"],
      reason: "mergelane-daemon.exe says 'mergelane-daemon dev', expected 'mergelane-daemon 0.4.0'",
      leftRunning: 0
    })
    assert.equal(
      describeApp(stale),
      "x64   Mergelane: FAILED after 5 s: mergelane-daemon.exe says 'mergelane-daemon dev', expected 'mergelane-daemon 0.4.0'"
    )
    assert.equal(appVerdict(stale), 'must')
  })

  it('reads a report from before the app check (no apps)', () => {
    const { lines } = summarize(report())
    assert.equal(lines.includes('Mergelane opened from the kit:'), false)
  })
})
