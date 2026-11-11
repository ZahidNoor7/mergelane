import type { IpFamily, NetworkInterfaceInfo, StreamProbeResult } from '../../../shared/types'
import type { ToolResolution } from '../../media/mux'
import {
  YoutubeError,
  parseVideo,
  runYtDlp,
  startLoopbackProxy,
  youtubePlan,
  youtubeVariants,
  type Dial,
  type YoutubePlan,
  type YoutubeVideo
} from '../../media/youtube'

// YouTube links as stream downloads (ADR-0026): what New download shows for one, and what its
// download takes. The fetching is StreamTransfer's, with a YoutubeSession for the addresses.

/** Where yt-dlp and Deno are (see resolveToolPath), and how long yt-dlp may take. */
export interface YoutubeTools {
  ytDlp: () => Promise<ToolResolution>
  deno: () => Promise<ToolResolution>
  timeoutMs?: number
}

/** The paths of yt-dlp and Deno, or a YoutubeError saying which one is missing, and where it was
 * looked for. */
export async function youtubePrograms(
  tools: YoutubeTools
): Promise<{ ytDlp: string; deno: string }> {
  const [ytDlp, deno] = await Promise.all([tools.ytDlp(), tools.deno()])
  for (const [name, found] of [
    ['yt-dlp', ytDlp],
    ['Deno', deno]
  ] as const) {
    if (found.path === null) {
      throw new YoutubeError(
        'failed',
        `Mergelane needs ${name} to download from YouTube, and couldn’t find it. ${found.reason}`
      )
    }
  }
  return { ytDlp: ytDlp.path!, deno: deno.path! }
}

/** Asks yt-dlp about the video at `url` (a youtubeWatchUrl), through `dial`'s network when one is
 * given and directly otherwise. */
export async function extractYoutube(
  url: string,
  tools: YoutubeTools,
  options: { dial?: Dial; signal?: AbortSignal } = {}
): Promise<YoutubeVideo> {
  const programs = await youtubePrograms(tools)
  const proxy = options.dial ? await startLoopbackProxy(options.dial) : undefined
  try {
    const json = await runYtDlp({
      ...programs,
      url,
      ...(proxy && { proxy: proxy.url }),
      ...(tools.timeoutMs !== undefined && { timeoutMs: tools.timeoutMs }),
      ...(options.signal && { signal: options.signal })
    })
    return parseVideo(json)
  } finally {
    await proxy?.close()
  }
}

/** The address family a network asks YouTube from and fetches over: IPv4 when it has an IPv4
 * address, else IPv6. One family for both, because the addresses YouTube hands out are tied to
 * the address that asked. */
export function youtubeFamily(network: NetworkInterfaceInfo | undefined): IpFamily {
  return network?.addresses.some((address) => address.family === 4) === false ? 6 : 4
}

/** Videos described lately, by watch URL: so starting one just checked doesn't ask yt-dlp again
 * only to plan its segments. Kept in memory only, never saved: its addresses are signed. */
const described = new Map<string, { video: YoutubeVideo; at: number }>()
const DESCRIBED_FOR_MS = 30 * 60_000
const DESCRIBED_MAX = 16

function remember(url: string, video: YoutubeVideo): void {
  described.delete(url)
  described.set(url, { video, at: Date.now() })
  while (described.size > DESCRIBED_MAX) described.delete(described.keys().next().value!)
}

/** What New download shows for a YouTube video: its qualities, best first, each with its size. */
export async function describeYoutube(
  requestedUrl: string,
  url: string,
  tools: YoutubeTools,
  signal?: AbortSignal
): Promise<StreamProbeResult> {
  const video = await extractYoutube(url, tools, { signal })
  const variants = youtubeVariants(video)
  if (variants.length === 0) throw new YoutubeError('no-formats')
  remember(url, video)
  return {
    kind: 'stream',
    requestedUrl,
    finalUrl: url,
    // Its formats are fetched in ranges over every network.
    supportsRanges: true,
    totalBytes: null,
    suggestedFileName: video.title,
    contentType: null,
    etag: null,
    lastModified: null,
    stream: {
      protocol: 'youtube',
      variants,
      ...(video.durationSeconds !== undefined && { durationSeconds: video.durationSeconds })
    }
  }
}

/** The plan for starting a download of `url`'s quality `variantId`: from the video New download
 * just described when there is one, else from asking yt-dlp once more. */
export async function planYoutube(
  url: string,
  variantId: string | undefined,
  tools: YoutubeTools,
  signal?: AbortSignal
): Promise<YoutubePlan> {
  const recent = described.get(url)
  const video =
    recent && Date.now() - recent.at < DESCRIBED_FOR_MS
      ? recent.video
      : await extractYoutube(url, tools, { signal })
  return youtubePlan(video, variantId)
}

/** Forgets every video described (for tests). */
export function forgetDescribed(): void {
  described.clear()
}
