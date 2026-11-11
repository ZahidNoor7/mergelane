import { fileTypeOf, type FileType } from './downloadFilters'

// What the browser extension sends to Mergelane, set once in Settings › Browser extensions for every
// browser (M3.4b, docs/DECISIONS.md ADR-0039). The app applies them when a download arrives, and
// tells the extension whether capture is on and whether to list a page's videos.

/** The types Settings offers, in the design's order (prototype.html, FILE_TYPES). Images aren't
 * offered: a picture saved from a page stays with the browser. */
export const CAPTURE_TYPES: { id: FileType; label: string }[] = [
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'archive', label: 'Archives' },
  { id: 'disk', label: 'Disk images' },
  { id: 'app', label: 'Apps and installers' },
  { id: 'doc', label: 'Documents' }
]

export type MinSize = 'any' | '1mb' | '10mb' | '100mb'

export const MIN_SIZES: { id: MinSize; label: string; bytes: number }[] = [
  { id: 'any', label: 'Any size', bytes: 0 },
  { id: '1mb', label: '1 MB', bytes: 1024 * 1024 },
  { id: '10mb', label: '10 MB', bytes: 10 * 1024 * 1024 },
  { id: '100mb', label: '100 MB', bytes: 100 * 1024 * 1024 }
]

export interface CaptureRules {
  /** Send downloads to Mergelane at all. */
  capture: boolean
  minSize: MinSize
  /** The types Mergelane takes; a file of unknown type is always taken (owner, ADR-0039). */
  types: FileType[]
  /** List the videos found on a page (the extension's menu and the count on its icon). */
  videoButton: boolean
}

/** The design's defaults (prototype.html, ext): over 1 MB; video, archives, disk images, apps. */
export const DEFAULT_CAPTURE_RULES: CaptureRules = {
  capture: true,
  minSize: '1mb',
  types: ['video', 'archive', 'disk', 'app'],
  videoButton: true
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Saved or sent rules, each field checked on its own; anything wrong takes the default. */
export function sanitizeCaptureRules(value: unknown): CaptureRules {
  const rules = isRecord(value) ? value : {}
  const offered = CAPTURE_TYPES.map((type) => type.id)
  return {
    capture: typeof rules.capture === 'boolean' ? rules.capture : DEFAULT_CAPTURE_RULES.capture,
    minSize: MIN_SIZES.some((size) => size.id === rules.minSize)
      ? (rules.minSize as MinSize)
      : DEFAULT_CAPTURE_RULES.minSize,
    types: Array.isArray(rules.types)
      ? offered.filter((id) => (rules.types as unknown[]).includes(id))
      : DEFAULT_CAPTURE_RULES.types,
    videoButton:
      typeof rules.videoButton === 'boolean' ? rules.videoButton : DEFAULT_CAPTURE_RULES.videoButton
  }
}

export function minBytesOf(size: MinSize): number {
  return MIN_SIZES.find((each) => each.id === size)?.bytes ?? 0
}

/**
 * Why the browser should keep a file it was about to hand over, or null when Mergelane takes it.
 * `size` is null when the server doesn't say. A torrent or news file isn't sorted by type.
 */
export function keptBy(
  rules: CaptureRules,
  file: { kind: string; fileName: string; size: number | null }
): string | null {
  if (!rules.capture) return 'sending downloads to Mergelane is off'
  if (file.size !== null && file.size < minBytesOf(rules.minSize)) {
    return 'smaller than the minimum size'
  }
  if (file.kind === 'torrent' || file.kind === 'nzb') return null
  const type = fileTypeOf({ kind: file.kind, fileName: file.fileName })
  if (type !== 'other' && !rules.types.includes(type)) return 'a type Mergelane doesn’t take'
  return null
}
