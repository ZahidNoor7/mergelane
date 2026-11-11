import type { SystemMergeRemoval } from '../../shared/types'
import { callDaemon } from './client'
import { uninstallCommand } from './installCommand'
import { mergeIsOn, readSnapshot, type SnapshotContext } from './snapshot'

// "Remove helper" (docs/DECISIONS.md ADR-0046). Free of Electron, like snapshot.ts, so the e2e
// suite's Node side runs it against a fake daemon with a stand-in for the password prompt
// (e2e/daemonApi.spec.ts); daemon.ts supplies the context and the real prompt.

/** Runs an AppleScript through osascript: the administrator password prompt. Rejects when the
 * script fails, the prompt being dismissed included. */
export type AdminRunner = (script: string) => Promise<unknown>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a failed osascript run came to: whether the password prompt was dismissed (AppleScript
 * error -128, "User canceled"), and the reason in words. TN2065: a command that exits non-zero
 * becomes an AppleScript error whose message is what it printed to standard error; osascript
 * prints that to its own standard error, which execFile's error carries as `stderr`. Its exact
 * layout ("0:42: execution error: … (1)") is not documented, so it is only tidied when it matches. */
export function adminFailure(error: unknown): { canceled: boolean; reason: string } {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const raw = typeof stderr === 'string' && stderr.trim() ? stderr : message(error)
  const reason = raw
    .trim()
    .replace(/^\d+:\d+: execution error: /, '')
    .replace(/ \(-?\d+\)$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    canceled: /\(-128\)\s*$|User cancell?ed/i.test(raw),
    reason: reason || 'osascript failed without saying why.'
  }
}

/** The password prompt as a test run answers it (MERGELANE_E2E_ADMIN_PROMPT, testKnobs.ts):
 * 'allow' succeeds, 'cancel' fails as osascript does when the prompt is dismissed, and
 * 'fail:<reason>' fails with that reason, as a command that exits 1. Nothing is run. */
export async function simulatedAdminPrompt(answer: string): Promise<void> {
  if (answer === 'allow') return
  const stderr =
    answer === 'cancel'
      ? '0:0: execution error: User canceled. (-128)\n'
      : `0:0: execution error: ${answer.replace(/^fail:/, '') || 'failed'} (1)\n`
  throw Object.assign(new Error(`Command failed: osascript\n${stderr}`), { stderr })
}

/** Turns system merge off, then removes the helper with one administrator password prompt. Off
 * first, so its routes are gone before the helper is (CLAUDE.md, Crash safety); the helper's own
 * uninstall then boots it out and cleans up routes once more. A helper that can't be asked to turn
 * off is removed anyway: the uninstall's cleanup is what removes a stuck helper's routes. When the
 * prompt is dismissed, merging that was on is turned back on, since nothing was removed.
 * `context` is asked again after the removal, so the snapshot sees the helper gone. */
export async function removeHelper(
  context: () => SnapshotContext,
  binary: string,
  runAsAdmin: AdminRunner
): Promise<SystemMergeRemoval> {
  const before = context()
  const socket = before.socketPath ? { socketPath: before.socketPath } : {}
  const wasOn = await mergeIsOn(before)
  if (wasOn) await callDaemon('disable', {}, socket).catch(() => undefined)
  try {
    await runAsAdmin(uninstallCommand(binary))
  } catch (caught) {
    const { canceled, reason } = adminFailure(caught)
    if (!canceled) {
      return {
        outcome: 'failed',
        message: `Couldn't remove the helper: ${reason}`,
        snapshot: await readSnapshot(context())
      }
    }
    let note = ''
    if (wasOn) {
      await callDaemon('enable', undefined, socket).catch((refused: unknown) => {
        note = ` System merge stayed off: ${message(refused)}`
      })
    }
    return {
      outcome: 'canceled',
      message: `Removal canceled. The helper is still installed.${note}`,
      snapshot: await readSnapshot(context())
    }
  }
  return {
    outcome: 'removed',
    message: 'Helper removed. Install it again to use system merge.',
    snapshot: await readSnapshot(context())
  }
}
