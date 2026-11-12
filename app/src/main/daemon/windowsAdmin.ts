import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import {
  elevationOutcome,
  elevationScript,
  encodedCommand,
  userSidFromWhoami,
  type ElevationOutcome
} from '../../shared/windowsHelper'

// Installing and removing the system-wide helper on Windows (W5, ADR-0059): through Windows'
// administrator prompt, as macOS's password prompt does it (installCommand.ts). Free of Electron, like
// removal.ts, so the e2e suite's Node side runs it with a stand-in for the programs it starts.

/** Runs a program and resolves with its exit code and output; never rejects for a non-zero exit. */
export type ProgramRunner = (
  file: string,
  args: readonly string[]
) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** Runs a program with no console window. */
export const runProgram: ProgramRunner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      // A number is the program's exit code; anything else means it never started (ENOENT, EACCES), and
      // that error's message is all there is to say.
      const exited = !error || typeof error.code === 'number'
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout),
        stderr: exited ? String(stderr) : String(stderr) || error.message
      })
    })
  })

/** Where the elevated runs happen: Windows' folder, and the folder the --report file goes in. */
export interface WindowsAdminContext {
  run: ProgramRunner
  systemRoot: string
  tempDir: string
}

/** An elevated run that didn't finish: declined at the prompt, or failed with a reason. */
export class ElevationError extends Error {
  constructor(readonly outcome: ElevationOutcome) {
    super(outcome.reason)
    this.name = 'ElevationError'
  }
}

/** What a failed install or removal came to, for removal.ts: declined, or why it failed. */
export function elevationFailure(error: unknown): { canceled: boolean; reason: string } {
  if (error instanceof ElevationError) {
    return { canceled: error.outcome.canceled, reason: error.outcome.reason }
  }
  return {
    canceled: false,
    reason:
      error instanceof Error ? error.message : String(error) || 'it failed without saying why.'
  }
}

/** The security identifier of the user the app runs as, from whoami.exe: the one user the helper's pipe
 * lets in besides administrators. */
export async function currentUserSid(context: WindowsAdminContext): Promise<string> {
  const whoami = win32.join(context.systemRoot, 'System32', 'whoami.exe')
  const { code, stdout } = await context.run(whoami, ['/user', '/fo', 'csv', '/nh'])
  const sid = code === 0 ? userSidFromWhoami(stdout) : null
  if (!sid) throw new Error('Windows didn’t say which user this is (whoami).')
  return sid
}

/** Runs the bundled helper with args as administrator, through Windows' prompt, and waits. The helper
 * writes its result to a new file in tempDir (--report), read and removed here. Throws an ElevationError
 * when the prompt is declined or the helper fails. */
export async function runHelperElevated(
  binary: string,
  args: readonly string[],
  context: WindowsAdminContext
): Promise<void> {
  // The platform's own join: the report is a real file the app reads back (Windows paths on Windows).
  const report = join(context.tempDir, `mergelane-helper-${randomUUID()}.txt`)
  const powershell = win32.join(
    context.systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const script = elevationScript(binary, [...args, '--report', report])
  try {
    const { code, stderr } = await context.run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand(script)
    ])
    const text = await readFile(report, 'utf8').catch(() => null)
    const outcome = elevationOutcome(code, text, stderr)
    if (!outcome.ok) throw new ElevationError(outcome)
  } finally {
    await rm(report, { force: true })
  }
}

/** Installs the bundled helper as the Windows service, for this user. */
export async function installOnWindows(
  binary: string,
  context: WindowsAdminContext
): Promise<void> {
  const sid = await currentUserSid(context)
  await runHelperElevated(binary, ['install', '--user-sid', sid, '--source', binary], context)
}

/** Removes the service, its routes and its program, with the bundled helper's `uninstall`. */
export function uninstallOnWindows(binary: string, context: WindowsAdminContext): Promise<void> {
  return runHelperElevated(binary, ['uninstall'], context)
}
