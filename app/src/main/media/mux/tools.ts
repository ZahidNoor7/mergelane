import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** The outside programs Mergelane runs (docs/MEDIA-TOOLS.md). They ship as separate executables
 * and are never linked into the app (CLAUDE.md, Licensing). Deno is the JavaScript runtime yt-dlp
 * runs YouTube's player challenges in (ADR-0026). */
export type MediaTool = 'ffmpeg' | 'yt-dlp' | 'deno'

/** Environment variables that point a development build or the test suite at another copy of a
 * tool. A packaged app ignores them, as it ignores every test knob (see src/main/testKnobs.ts),
 * so a shipped app can't be steered into running some other program through its environment. */
export const TOOL_PATH_ENV: Readonly<Record<MediaTool, string>> = {
  ffmpeg: 'MERGELANE_FFMPEG_PATH',
  'yt-dlp': 'MERGELANE_YTDLP_PATH',
  deno: 'MERGELANE_DENO_PATH'
}

/** Where each tool's program sits, relative to where the tools are installed (the app's
 * `Contents/Resources` when packaged, `app/resources/bin` in development). yt-dlp is a folder:
 * its unpacked macOS build, the program beside its `_internal` files (ADR-0031). Keep these in
 * step with `install` and `executable` in scripts/media-tools/tools.json and with
 * app/electron-builder.yml. */
export const TOOL_PROGRAM: Readonly<Record<MediaTool, string>> = {
  ffmpeg: 'ffmpeg',
  'yt-dlp': 'yt-dlp/yt-dlp_macos',
  deno: 'deno'
}

const TOOL_LABEL: Readonly<Record<MediaTool, string>> = {
  ffmpeg: 'FFmpeg',
  'yt-dlp': 'yt-dlp',
  deno: 'Deno'
}

/** Where the app runs from. Injected rather than read from `electron`, so this module also runs in
 * plain Node (the e2e suite's Layer B). In the main process pass `app.isPackaged`,
 * `process.resourcesPath` and `app.getAppPath()`. */
export interface ToolLocations {
  isPackaged: boolean
  /** `Mergelane.app/Contents/Resources` when packaged; tools sit inside it (see
   * {@link TOOL_PROGRAM}). */
  resourcesPath: string
  /** The `app/` folder; in development tools sit in `<appRoot>/resources/bin`, where
   * `npm run fetch:media-tools` puts them. */
  appRoot: string
  /** Defaults to `process.env`. Never read when packaged. */
  env?: NodeJS.ProcessEnv
}

/** Which rule picked the path: the environment override, the app bundle, or the development
 * folder. */
export type ToolSource = 'override' | 'packaged' | 'development'

/** A usable tool, or `path: null` with a sentence saying why not and where it looked. */
export type ToolResolution =
  | { path: string; source: ToolSource }
  | { path: null; source: ToolSource; candidate: string; reason: string }

/** What is wrong with the file at `path`, or null when it's an executable regular file. */
async function problemWith(path: string): Promise<string | null> {
  let isFile: boolean
  try {
    isFile = (await stat(path)).isFile()
  } catch {
    return `was not found at ${path}`
  }
  if (!isFile) return `at ${path} is not a file`
  try {
    await access(path, constants.X_OK)
  } catch {
    return `at ${path} is not executable`
  }
  return null
}

const HINT: Readonly<Record<ToolSource, string>> = {
  override: '',
  packaged: ' Reinstall Mergelane to restore it.',
  development: ' Run "npm run fetch:media-tools" in app/ to download it.'
}

/**
 * Finds a media tool's program: its variable in {@link TOOL_PATH_ENV} when set (development and
 * tests only; it must be the program's absolute path), else `<resourcesPath>/<program>` when
 * packaged, else `<appRoot>/resources/bin/<program>`, with `<program>` from {@link TOOL_PROGRAM}
 * (`yt-dlp/yt-dlp_macos` for yt-dlp). The file must exist, be a regular file and be executable.
 *
 * Never throws for a missing tool: it resolves `{ path: null, reason }` with a sentence fit for
 * logs and the diagnostics screen.
 */
export async function resolveToolPath(
  tool: MediaTool,
  where: ToolLocations
): Promise<ToolResolution> {
  const label = TOOL_LABEL[tool]
  const variable = TOOL_PATH_ENV[tool]
  const override = where.isPackaged ? undefined : (where.env ?? process.env)[variable]

  let source: ToolSource
  let candidate: string
  if (override) {
    source = 'override'
    candidate = override
    if (!isAbsolute(candidate)) {
      return {
        path: null,
        source,
        candidate,
        reason: `${variable} must be an absolute path, but it is "${candidate}".`
      }
    }
  } else if (where.isPackaged) {
    source = 'packaged'
    candidate = join(where.resourcesPath, TOOL_PROGRAM[tool])
  } else {
    source = 'development'
    candidate = join(where.appRoot, 'resources', 'bin', TOOL_PROGRAM[tool])
  }

  const problem = await problemWith(candidate)
  if (problem === null) return { path: candidate, source }
  const via = source === 'override' ? ` (set by ${variable})` : ''
  return { path: null, source, candidate, reason: `${label} ${problem}${via}.${HINT[source]}` }
}
