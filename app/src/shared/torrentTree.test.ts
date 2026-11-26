import { describe, expect, it } from 'vitest'
import { baseName, chosenBytes, fileGroups, isVideo, videosOnly } from './torrentTree'

// The design's FILM_PACK: files at the top, a folder, and a folder inside it.
const FILM_PACK = [
  'open-film-pack/01-meadow-2160p.mkv',
  'open-film-pack/02-harbour-2160p.mkv',
  'open-film-pack/03-night-train-1080p.mkv',
  'open-film-pack/extras/making-of.mp4',
  'open-film-pack/extras/subtitles/en.srt',
  'open-film-pack/extras/subtitles/fr.srt',
  'open-film-pack/README.txt'
]

describe('a torrent’s folders', () => {
  it('lists the top files first, then each folder inside, as Finder does', () => {
    expect(fileGroups(FILM_PACK)).toEqual([
      { folder: '', indices: [0, 1, 2, 6] },
      { folder: 'extras', indices: [3] },
      { folder: 'extras/subtitles', indices: [4, 5] }
    ])
  })

  it('reads Windows paths too, and folders in name order', () => {
    expect(fileGroups(['Set\\b\\x.bin', 'Set\\a\\y.bin', 'Set\\z.bin'])).toEqual([
      { folder: '', indices: [2] },
      { folder: 'a', indices: [1] },
      { folder: 'b', indices: [0] }
    ])
  })

  it('a torrent of one file has no folder to leave out', () => {
    expect(fileGroups(['debian.iso'])).toEqual([{ folder: '', indices: [0] }])
    expect(fileGroups(['Disk/debian.iso'])).toEqual([{ folder: '', indices: [0] }])
    expect(fileGroups([])).toEqual([])
  })

  it('names a file without its folders', () => {
    expect(baseName('open-film-pack/extras/making-of.mp4')).toBe('making-of.mp4')
    expect(baseName('C:\\x\\y.bin')).toBe('y.bin')
    expect(baseName('')).toBe('')
  })
})

describe('Videos only', () => {
  it('knows a video by its name', () => {
    expect(['a.mkv', 'b.MP4', 'c.mov', 'd.webm', 'e.m4v', 'f.avi'].every(isVideo)).toBe(true)
    expect(['a.srt', 'README.txt', 'mkv', 'film.mkv.part'].some(isVideo)).toBe(false)
  })

  it('skips the rest, but never a file already downloaded', () => {
    expect(videosOnly(FILM_PACK, () => false)).toEqual([4, 5, 6])
    expect(videosOnly(FILM_PACK, (index) => index === 6)).toEqual([4, 5])
  })
})

describe('the size chosen', () => {
  it('adds up the files not skipped', () => {
    expect(chosenBytes([10, 20, 30], [])).toBe(60)
    expect(chosenBytes([10, 20, 30], [1])).toBe(40)
    expect(chosenBytes([10, 20, 30], [0, 1, 2])).toBe(0)
  })
})
