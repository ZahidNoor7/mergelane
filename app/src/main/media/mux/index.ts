// Logic adapted from Awesome Downloader core/mux.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)

/**
 * Joining and rewrapping downloaded media with FFmpeg, without re-encoding.
 *
 * FFmpeg ships as a separate executable in the app bundle: Mergelane's own minimal LGPL build, made
 * from FFmpeg's source release for stream copy only (ADR-0028). It is only ever run as a child
 * process, never linked (CLAUDE.md, Licensing). This module never decrypts anything: it copies
 * streams Mergelane already downloaded in the clear.
 *
 * Typical use:
 *
 * ```ts
 * const ffmpeg = await resolveToolPath('ffmpeg', {
 *   isPackaged: app.isPackaged,
 *   resourcesPath: process.resourcesPath,
 *   appRoot: app.getAppPath()
 * })
 * if (ffmpeg.path === null) return showError(ffmpeg.reason)
 * await muxVideoAudio({ ffmpeg: ffmpeg.path, video, audio, output, container: 'auto', codecs })
 * await remux({ ffmpeg: ffmpeg.path, input: tsFile, output, container: 'mp4' })
 * ```
 *
 * Failures are {@link MuxError}s whose `message` can be shown as is; FFmpeg's own stderr is kept
 * out of the message, in `detail`. Aborting a job stops FFmpeg (SIGTERM, then SIGKILL after
 * {@link KILL_GRACE_MS}) and deletes its temporary file.
 *
 * The module is self-contained: it does not touch the download manager, settings or UI, and does
 * not import `electron`.
 *
 * @module
 */

export { MuxError, type MuxErrorCode } from './errors'

export {
  TOOL_PATH_ENV,
  TOOL_PROGRAM,
  WINDOWS_TOOL_PROGRAM,
  resolveToolPath,
  toolProgram,
  type MediaTool,
  type ToolLocations,
  type ToolResolution,
  type ToolSource
} from './tools'

export { containerForCodecs, type Container } from './codecs'

export {
  INPUT_DEMUXERS,
  KILL_GRACE_MS,
  TEMP_SUFFIX,
  type JobOptions,
  type MuxProgress
} from './run'

export {
  muxVideoAudio,
  type ContainerChoice,
  type ContainerOptions,
  type MuxOptions,
  type MuxResult
} from './mux'

export { remux, type RemuxOptions } from './remux'
