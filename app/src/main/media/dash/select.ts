import { DashError, protectedStream } from './errors'
import type { AdaptationSet, Mpd, Representation } from './parse'

/** One video quality, for a quality picker. */
export interface VideoQuality {
  /** Representation@id: what {@link SelectOptions.videoId} takes. */
  id: string
  /** Bits per second, as the MPD declares it. */
  bandwidth: number
  width?: number
  height?: number
  codecs?: string
  mimeType?: string
}

export interface SelectOptions {
  /** This video representation, by id. */
  videoId?: string
  /** The best video no taller than this many pixels (or the smallest, if all are taller). */
  height?: number
  /** Prefer audio in this language: a BCP 47 tag such as "en", which also matches "en-GB". */
  audioLanguage?: string
}

export interface Selection {
  /** Undefined only for an audio-only stream. */
  video?: Representation
  /** Undefined when the stream has no separate audio (none at all, or muxed into the video). */
  audio?: Representation
}

/** Video sets that are the programme itself: not trick-mode frames, which "the DASH client shall
 * not select ... for regular playout" (DASH-IF identifier registry, trickmode). */
function videoRepresentations(mpd: Mpd): Representation[] {
  return mpd.adaptationSets
    .filter((set) => !set.trickMode)
    .flatMap((set) => set.representations)
    .filter((representation) => representation.contentType === 'video')
}

/** Taller first, then wider, then more bits per second; the MPD's order breaks ties. */
function byQuality(a: Representation, b: Representation): number {
  return (
    (b.height ?? 0) - (a.height ?? 0) ||
    (b.width ?? 0) - (a.width ?? 0) ||
    b.bandwidth - a.bandwidth
  )
}

/**
 * The video qualities a user can pick from, best first. Protected representations aren't
 * listed: Mergelane doesn't download them.
 */
export function listVideoQualities(mpd: Mpd): VideoQuality[] {
  return videoRepresentations(mpd)
    .filter((representation) => !representation.protected)
    .sort(byQuality)
    .map(({ id, bandwidth, width, height, codecs, mimeType }) => ({
      id,
      bandwidth,
      width,
      height,
      codecs,
      mimeType
    }))
}

function chooseVideo(mpd: Mpd, options: SelectOptions): Representation | undefined {
  const all = videoRepresentations(mpd)
  if (options.videoId !== undefined) {
    const chosen = all.find((representation) => representation.id === options.videoId)
    if (!chosen) {
      throw new DashError('no-match', `This DASH stream has no video quality “${options.videoId}”.`)
    }
    if (chosen.protected) throw protectedStream()
    return chosen
  }
  if (all.length === 0) return undefined
  const ranked = all.filter((representation) => !representation.protected).sort(byQuality)
  if (ranked.length === 0) throw protectedStream()
  const { height } = options
  if (height === undefined) return ranked[0]
  return ranked.find((representation) => (representation.height ?? 0) <= height) ?? ranked.at(-1)
}

/** `sets` narrowed to those that `keep`, unless none do. */
function prefer(sets: AdaptationSet[], keep: (set: AdaptationSet) => boolean): AdaptationSet[] {
  const kept = sets.filter(keep)
  return kept.length > 0 ? kept : sets
}

function languageMatches(lang: string | undefined, wanted: string): boolean {
  if (lang === undefined) return false
  const have = lang.toLowerCase()
  const want = wanted.toLowerCase()
  return have === want || have.startsWith(`${want}-`)
}

/**
 * The audio set, in the order dash.js chooses an initial track
 * (https://dashif.org/dash.js/pages/usage/track-selection.html): the language asked for, then the
 * highest AdaptationSet@selectionPriority, then Role "main" — a set with no Role counting as
 * main when none says so, as dash.js's assumeDefaultRoleAsMain does — then the first in the MPD.
 * Within the set, the representation with the most bits per second.
 */
function chooseAudio(mpd: Mpd, options: SelectOptions): Representation | undefined {
  const all = mpd.adaptationSets.filter(
    (set) => set.contentType === 'audio' && !set.trickMode && set.representations.length > 0
  )
  if (all.length === 0) return undefined
  let sets = all.filter((set) => set.representations.some((item) => !item.protected))
  // Video without its sound isn't the programme; say why rather than download half of it.
  if (sets.length === 0) throw protectedStream()
  const { audioLanguage } = options
  if (audioLanguage) sets = prefer(sets, (set) => languageMatches(set.lang, audioLanguage))
  const priority = Math.max(...sets.map((set) => set.selectionPriority))
  sets = sets.filter((set) => set.selectionPriority === priority)
  const anyMain = sets.some((set) => set.roles.includes('main'))
  sets = prefer(sets, (set) => (anyMain ? set.roles.includes('main') : set.roles.length === 0))
  return sets[0].representations
    .filter((representation) => !representation.protected)
    .sort((a, b) => b.bandwidth - a.bandwidth)[0]
}

/**
 * The representations to download: the best video (or the one asked for by id or height) and
 * the best audio. Throws a {@link DashError}: 'protected' when what would be chosen is
 * protected, 'no-match' when the id isn't a video representation or the MPD has neither video
 * nor audio.
 */
export function selectRepresentations(mpd: Mpd, options: SelectOptions = {}): Selection {
  const video = chooseVideo(mpd, options)
  const audio = chooseAudio(mpd, options)
  if (!video && !audio) {
    throw new DashError(
      'no-match',
      'This DASH stream has no video or audio Mergelane can download.'
    )
  }
  return { video, audio }
}
