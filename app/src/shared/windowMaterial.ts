// The Liquid Glass theme's material on Windows (W1). macOS draws vibrancy behind the window; Windows 11 22H2 and
// later have system backdrops instead (Electron's BrowserWindow.setBackgroundMaterial, "only supported on Windows
// 11 22H2 and up"). Acrylic is the one that blurs what is behind the window, as vibrancy does. Windows 10 and
// older Windows 11 keep the theme's solid ground, as does a PC with transparency effects off.

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

/** The backdrop to set: acrylic for Liquid Glass while transparency is allowed, none otherwise; null where the
 * call isn't supported, so nothing is set. */
export function windowsBackdrop(options: {
  build: number
  liquid: boolean
  solid: boolean
  reducedTransparency: boolean
}): 'acrylic' | 'none' | null {
  if (!backdropSupported(options.build)) return null
  return options.liquid && !options.solid && !options.reducedTransparency ? 'acrylic' : 'none'
}
