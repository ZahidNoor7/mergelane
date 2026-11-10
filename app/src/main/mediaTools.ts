import { app } from 'electron'
import { resolveToolPath, type MediaTool, type ToolResolution } from './media/mux'
import type { YoutubeTools } from './download/stream/youtubeStream'

/** Finds a bundled media tool where this app keeps it: inside the app when packaged, in
 * app/resources/bin in development, or where a development build's environment points (see
 * resolveToolPath). */
export function findMediaTool(tool: MediaTool): Promise<ToolResolution> {
  return resolveToolPath(tool, {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath()
  })
}

/** yt-dlp and Deno, for YouTube videos (ADR-0026). */
export const youtubeTools: YoutubeTools = {
  ytDlp: () => findMediaTool('yt-dlp'),
  deno: () => findMediaTool('deno')
}
