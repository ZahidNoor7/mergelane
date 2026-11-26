// A torrent's files as New download and a download's details list them (docs/plans/
// 2026-11-new-features-plan.md, feature 9; the design's TorrentFiles and fileTree): the files at the
// top of the torrent's folder first, then each folder inside it, in name order, as Finder lists them.
// Pure, so it is unit-tested on its own.

/** One folder of files, by index into the torrent's list. `folder` is '' for the top. */
export interface FileGroup {
  folder: string
  indices: number[]
}

const parts = (path: string): string[] => path.split(/[\\/]/).filter(Boolean)

/** A file's name, without its folders. */
export const baseName = (path: string): string => parts(path).at(-1) ?? path

/** The folders a torrent's files sit in, each with its files. A torrent of several files puts all
 * of them in a folder of its own, which every path starts with: that one isn't listed. */
export function fileGroups(paths: readonly string[]): FileGroup[] {
  const shared = paths.length > 1 || parts(paths[0] ?? '').length > 1
  const groups = new Map<string, number[]>()
  paths.forEach((path, index) => {
    const segments = parts(path)
    const inner = shared ? segments.slice(1, -1) : []
    const folder = inner.join('/')
    groups.set(folder, [...(groups.get(folder) ?? []), index])
  })
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, indices]) => ({ folder, indices }))
}

const VIDEO = /\.(mkv|mp4|m4v|mov|webm|avi)$/i

/** A video file, by its name. */
export const isVideo = (path: string): boolean => VIDEO.test(path)

/** "Videos only": every file that isn't a video is skipped, bar any already downloaded (those are
 * in, and stay). */
export function videosOnly(
  paths: readonly string[],
  finished: (index: number) => boolean
): number[] {
  return paths.flatMap((path, index) => (isVideo(path) || finished(index) ? [] : [index]))
}

/** The bytes of the files not skipped. */
export function chosenBytes(lengths: readonly number[], skipped: readonly number[]): number {
  return lengths.reduce((sum, length, index) => (skipped.includes(index) ? sum : sum + length), 0)
}
