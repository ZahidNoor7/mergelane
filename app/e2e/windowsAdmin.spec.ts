import { expect, test } from '@playwright/test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ElevationError,
  currentUserSid,
  elevationFailure,
  installOnWindows,
  runProgram,
  uninstallOnWindows,
  type ProgramRunner,
  type WindowsAdminContext
} from '../src/main/daemon/windowsAdmin'
import { ELEVATION_CANCELED } from '../src/shared/windowsHelper'

// The system-wide helper's install and removal on Windows (W5, ADR-0059), run here with a stand-in for
// whoami.exe and powershell.exe: what is started, with which arguments, and how its answer is read. Windows
// itself, and its administrator prompt, are only on the laptop (the kit's acceptance step).

const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'
const BINARY =
  'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Mergelane\\resources\\mergelane-daemon.exe'

/** Decodes powershell.exe's -EncodedCommand back into the script. */
function scriptOf(args: readonly string[]): string {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
}

/** The --report file the script passes to the helper: the last quoted argument in its argument line. */
function reportOf(script: string): string {
  const match = /--report "?([^"']+)"?'/.exec(script)
  if (!match) throw new Error(`no --report in ${script}`)
  return match[1]
}

interface Stand {
  context: WindowsAdminContext
  calls: { file: string; args: readonly string[] }[]
  dir: string
}

/** A stand-in Windows: whoami answers with SID; powershell does what `elevated` says. The report file
 * lives in a real temporary folder, written where the script says. */
function stand(
  elevated: (script: string) => { code: number | null; report?: string; stderr?: string },
  whoami: { code: number; stdout: string } = { code: 0, stdout: `"desktop-7\\ana","${SID}"\r\n` }
): Stand {
  const dir = mkdtempSync(join(tmpdir(), 'mergelane-windows-admin-'))
  const calls: Stand['calls'] = []
  const run: ProgramRunner = async (file, args) => {
    calls.push({ file, args })
    if (file.endsWith('whoami.exe')) return { ...whoami, stderr: '' }
    const script = scriptOf(args)
    const answer = elevated(script)
    if (answer.report !== undefined) writeFileSync(reportOf(script), answer.report)
    return { code: answer.code, stdout: '', stderr: answer.stderr ?? '' }
  }
  return { context: { run, systemRoot: 'C:\\Windows', tempDir: dir }, calls, dir }
}

test.describe('the helper on Windows @smoke', () => {
  let made: string[] = []
  test.afterEach(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true })
    made = []
  })
  const use = (s: Stand): Stand => {
    made.push(s.dir)
    return s
  }

  test('installs for this user through the administrator prompt, and cleans up its report', async () => {
    const s = use(stand(() => ({ code: 0, report: 'ok\n' })))
    await installOnWindows(BINARY, s.context)
    expect(s.calls.map((c) => c.file)).toEqual([
      'C:\\Windows\\System32\\whoami.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    expect(s.calls[0].args).toEqual(['/user', '/fo', 'csv', '/nh'])
    expect(s.calls[1].args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand'
    ])
    const script = scriptOf(s.calls[1].args)
    expect(script).toContain(`-FilePath '${BINARY}'`)
    expect(script).toContain(
      `-ArgumentList 'install --user-sid ${SID} --source "${BINARY}" --report `
    )
    expect(script).toContain('-Verb RunAs')
    expect(readdirSync(s.dir)).toEqual([])
  })

  test('removes with the bundled helper’s uninstall', async () => {
    const s = use(stand(() => ({ code: 0, report: 'ok\n' })))
    await uninstallOnWindows(BINARY, s.context)
    expect(s.calls).toHaveLength(1)
    expect(scriptOf(s.calls[0].args)).toContain("-ArgumentList 'uninstall --report ")
  })

  test('a declined prompt, a failed helper, and a missing report each say what happened', async () => {
    const declined = use(stand(() => ({ code: ELEVATION_CANCELED })))
    const caught = await uninstallOnWindows(BINARY, declined.context).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ElevationError)
    expect(elevationFailure(caught)).toEqual({ canceled: true, reason: 'canceled' })

    const failed = use(
      stand(() => ({ code: 1, report: 'error: install: wintun.dll is missing\n' }))
    )
    await expect(installOnWindows(BINARY, failed.context)).rejects.toThrow(
      'install: wintun.dll is missing'
    )
    expect(readdirSync(failed.dir)).toEqual([])

    const silent = use(
      stand(() => ({ code: 1, stderr: 'Start-Process : The system cannot find the file' }))
    )
    await expect(uninstallOnWindows(BINARY, silent.context)).rejects.toThrow(
      'Start-Process : The system cannot find the file'
    )
  })

  test('a user Windows can’t name is refused before any prompt', async () => {
    const s = use(stand(() => ({ code: 0, report: 'ok\n' }), { code: 0, stdout: '"x","S-1-1-0"' }))
    await expect(installOnWindows(BINARY, s.context)).rejects.toThrow(
      'Windows didn’t say which user this is (whoami).'
    )
    expect(s.calls).toHaveLength(1)
    const failing = use(stand(() => ({ code: 0 }), { code: 1, stdout: '' }))
    await expect(currentUserSid(failing.context)).rejects.toThrow('whoami')
  })

  test('any other failure reads as a reason, never as declined', () => {
    expect(elevationFailure(new Error('spawn EACCES'))).toEqual({
      canceled: false,
      reason: 'spawn EACCES'
    })
    expect(elevationFailure('')).toEqual({
      canceled: false,
      reason: 'it failed without saying why.'
    })
  })

  test('runs a real program and reports its exit code and output', async () => {
    expect(
      await runProgram(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'])
    ).toEqual({
      code: 3,
      stdout: 'hi',
      stderr: ''
    })
    const missing = await runProgram('/no/such/program', [])
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toMatch(/ENOENT/)
  })
})
