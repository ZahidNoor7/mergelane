import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { powerCommand, type PowerAction } from '../shared/powerCommand'
import { testKnobs, testRecord } from './testKnobs'

// Sleeping or shutting the computer down when the queue finishes (ADR-0079). Each asks the system
// politely: apps with unsaved work get their say, as when the user does it from the menu.
// - macOS sleep: `pmset sleepnow` ("causes an immediate system sleep", pmset(8)); no admin needed.
// - macOS shut down: the kAEShutDown Apple event ('aevt'/'shut', AERegistry.h) to loginwindow, as
//   Apple's QA1134 describes: "the restart, shutdown or logout sequence initiated using this method
//   can be cancelled by running applications". Sent through osascript; macOS may ask the user once
//   to let Mergelane control it (NSAppleEventsUsageDescription).
// - Windows sleep: .NET's Application.SetSuspendState(Suspend, force: false, …), which "causes
//   Windows to send a suspend request to every application" (learn.microsoft.com).
// - Windows shut down: `shutdown /s /t 0`. Never /f, and never a time-out above 0, which "implies
//   /f" ("Forces running applications to close without warning users").
// A test run never acts: it records what it would have done (testRecord 'power').

const run = promisify(execFile)

/** Asks the system to sleep or shut down. Throws when the system said no (macOS may refuse to let
 * Mergelane send the shutdown request until the user allows it). */
export async function powerDown(action: PowerAction): Promise<void> {
  const command = powerCommand(action, process.platform)
  if (testKnobs.userDataDir) {
    testRecord('power', { action, command })
    return
  }
  if (!command) throw new Error('This computer can’t be put to sleep or shut down from Mergelane.')
  await run(command[0], command[1], { timeout: 30_000 })
}
