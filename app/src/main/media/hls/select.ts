// Logic adapted from Awesome Downloader core/hls.mjs (MIT)
// Copyright (c) 2026 Awesome Downloader contributors
// https://github.com/Ahmadkhattak1/awesome-downloader (commit d99dbe0e9edfec1c07bbe735e1a1990323d919bf)
// Rewritten in TypeScript for Mergelane: selection by id or height, DEFAULT/AUTOSELECT audio and
// HDCP filtering were added; see docs/UPSTREAM.md.
//
// Section numbers refer to RFC 8216, https://www.rfc-editor.org/rfc/rfc8216.

import { HlsProtectedStreamError, HlsVariantNotFoundError } from './errors'
import type { MasterPlaylist, Rendition, Variant } from './parse'

/** Which variant to download. With neither field, the highest-bandwidth one. */
export interface VariantSelection {
  /** A {@link Variant.id} from {@link listVariants}. Takes precedence over `height`. */
  id?: string
  /** Preferred picture height in pixels (e.g. 1080). The best variant of exactly that height, else
   * the tallest one below it, else the shortest one above it, else the highest bandwidth when no
   * variant states a RESOLUTION. */
  height?: number
}

/** One row of a quality picker. */
export interface VariantOption {
  id: string
  /** Peak bits per second. */
  bandwidth: number
  averageBandwidth?: number
  resolution?: { width: number; height: number }
  codecs?: string[]
  frameRate?: number
  /** The variant plays with a separate audio rendition. */
  separateAudio: boolean
}

export interface SelectedVariant {
  variant: Variant
  /** The audio rendition to download alongside it, when its audio group has one. A rendition
   * without `uri` means the audio is inside the variant's own segments (§4.3.4.2.1). */
  audio?: Rendition
}

/** §4.3.4.2 HDCP-LEVEL: "Clients without output copy protection SHOULD NOT load a Variant Stream
 * with an HDCP-LEVEL attribute unless its value is NONE." A downloader has no output protection. */
function playable(master: MasterPlaylist): Variant[] {
  return master.variants.filter((variant) => (variant.hdcpLevel ?? 'NONE') === 'NONE')
}

const heightOf = (variant: Variant): number => variant.resolution?.height ?? 0

/** Best first: bandwidth, then height, then playlist order. */
function byQuality(a: Variant, b: Variant): number {
  return b.bandwidth - a.bandwidth || heightOf(b) - heightOf(a)
}

function sortedPlayable(master: MasterPlaylist): Variant[] {
  const variants = playable(master).sort(byQuality)
  if (variants.length === 0) {
    throw new HlsProtectedStreamError('every quality requires HDCP output protection')
  }
  return variants
}

/**
 * The audio rendition that goes with `variant`: from its AUDIO group (§4.3.4.2), the member marked
 * DEFAULT=YES, else the first AUTOSELECT=YES one, else the first listed (§4.3.4.1, §4.3.4.1.1: a
 * group has at most one DEFAULT). Undefined when the variant names no audio group or the group
 * has no members.
 */
export function selectAudioRendition(
  master: MasterPlaylist,
  variant: Variant
): Rendition | undefined {
  if (variant.audioGroup === undefined) return undefined
  const group = master.renditions.filter(
    (rendition) => rendition.type === 'AUDIO' && rendition.groupId === variant.audioGroup
  )
  return (
    group.find((rendition) => rendition.default) ??
    group.find((rendition) => rendition.autoselect) ??
    group[0]
  )
}

/** The variants a user can pick from, best first. Variants that require HDCP are left out. */
export function listVariants(master: MasterPlaylist): VariantOption[] {
  return sortedPlayable(master).map((variant) => ({
    id: variant.id,
    bandwidth: variant.bandwidth,
    ...(variant.averageBandwidth === undefined
      ? {}
      : { averageBandwidth: variant.averageBandwidth }),
    ...(variant.resolution ? { resolution: { ...variant.resolution } } : {}),
    ...(variant.codecs ? { codecs: [...variant.codecs] } : {}),
    ...(variant.frameRate === undefined ? {} : { frameRate: variant.frameRate }),
    separateAudio: selectAudioRendition(master, variant)?.uri !== undefined
  }))
}

function byHeight(variants: Variant[], height: number): Variant {
  const sized = variants.filter((variant) => variant.resolution)
  const exact = sized.find((variant) => heightOf(variant) === height)
  if (exact) return exact
  const below = sized
    .filter((variant) => heightOf(variant) < height)
    .sort((a, b) => heightOf(b) - heightOf(a) || b.bandwidth - a.bandwidth)
  if (below.length) return below[0]
  const above = sized
    .filter((variant) => heightOf(variant) > height)
    .sort((a, b) => heightOf(a) - heightOf(b) || b.bandwidth - a.bandwidth)
  return above[0] ?? variants[0]
}

/**
 * Picks a variant of `master` and its audio rendition.
 *
 * Throws {@link HlsVariantNotFoundError} for an unknown `id`, and
 * {@link HlsProtectedStreamError} when every variant requires HDCP.
 */
export function selectVariant(
  master: MasterPlaylist,
  selection: VariantSelection = {}
): SelectedVariant {
  const variants = sortedPlayable(master)
  let variant: Variant
  if (selection.id !== undefined) {
    const found = variants.find((candidate) => candidate.id === selection.id)
    if (!found) throw new HlsVariantNotFoundError(selection.id)
    variant = found
  } else if (selection.height !== undefined) {
    variant = byHeight(variants, selection.height)
  } else {
    variant = variants[0]
  }
  const audio = selectAudioRendition(master, variant)
  return audio ? { variant, audio } : { variant }
}
