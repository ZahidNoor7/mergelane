// What the interface calls the computer and its parts, by platform (Windows in W1), so a PC never hears about
// Finder or the menu bar. Read at render time (words()), so a test can switch window.mergelane.platform.

export interface PlatformWords {
  /** "Mac" or "PC": "your Mac's networks". */
  computer: string
  /** "this Mac" or "this PC". */
  thisComputer: string
  /** What follows the system's appearance: "your Mac", or "Windows". */
  appearanceSource: string
  /** "macOS" or "Windows". */
  system: string
  /** The command that shows a file in the file manager. */
  revealLabel: string
  /** Where Mergelane's icon and speed sit: "the menu bar", or "the notification area". */
  statusArea: string
  /** The Settings shortcut, as the keyboard shows it. */
  settingsShortcut: string
}

const MAC: PlatformWords = {
  computer: 'Mac',
  thisComputer: 'this Mac',
  appearanceSource: 'your Mac',
  system: 'macOS',
  revealLabel: 'Show in Finder',
  statusArea: 'the menu bar',
  settingsShortcut: '⌘,'
}

const WINDOWS: PlatformWords = {
  computer: 'PC',
  thisComputer: 'this PC',
  appearanceSource: 'Windows',
  system: 'Windows',
  revealLabel: 'Show in File Explorer',
  statusArea: 'the notification area',
  settingsShortcut: 'Ctrl+,'
}

/** The words for a platform; anything but Windows gets the Mac's, as before. */
export function platformWords(platform: string): PlatformWords {
  return platform === 'win32' ? WINDOWS : MAC
}

/** The words for the platform this window runs on. */
export function words(): PlatformWords {
  return platformWords(window.mergelane.platform)
}

/** Whether this window runs on Windows. */
export function onWindows(): boolean {
  return window.mergelane.platform === 'win32'
}
