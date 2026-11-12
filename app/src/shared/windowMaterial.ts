// The window's material on Windows (the design's Windows 11 study, ADR-0060): Mica behind every theme, the
// material Windows 11 uses behind app windows, which the title bar and the navigation pane sit straight on.
// Windows 11 22H2 and later have it (Electron's BrowserWindow.setBackgroundMaterial, "only supported on Windows
// 11 22H2 and up"). Windows 10, older Windows 11, and a PC with transparency effects off get the theme's ground
// instead (themes.ts windowsGround).

/** Windows 11 version 22H2 (Microsoft Learn, Windows 11 release information: OS build 22621). */
export const BACKDROP_FROM_BUILD = 22621

/** The build from Electron's process.getSystemVersion() on Windows ("10.0.22631"); 0 when there is none. */
export function windowsBuild(systemVersion: string): number {
  const build = Number(systemVersion.split('.')[2])
  return Number.isInteger(build) && build > 0 ? build : 0
}

/** Whether this Windows can draw a system backdrop at all. */
export function backdropSupported(build: number): boolean {
  return build >= BACKDROP_FROM_BUILD
}

/** The backdrop to set: Mica while transparency is allowed, none otherwise; null where the call isn't
 * supported, so nothing is set. */
export function windowsBackdrop(options: {
  build: number
  reducedTransparency: boolean
}): 'mica' | 'none' | null {
  if (!backdropSupported(options.build)) return null
  return options.reducedTransparency ? 'none' : 'mica'
}
