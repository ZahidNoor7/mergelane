import { describe, expect, it } from 'vitest'
import {
  findDuplicate,
  isDuplicateCheck,
  worthAskingForDigest,
  type DuplicateCandidate,
  type DuplicateQuery
} from './duplicates'

const SHA = 'a'.repeat(64)
const candidate = (fields: Partial<DuplicateCandidate>): DuplicateCandidate => ({
  id: 'have',
  kind: 'http',
  name: 'LibreOffice.dmg',
  link: 'https://mirror.example.net/tdf/LibreOffice.dmg',
  host: 'mirror.example.net',
  size: 300,
  live: false,
  completedAt: 5,
  sha256: SHA,
  ...fields
})
const query = (fields: Partial<DuplicateQuery>): DuplicateQuery => ({
  kind: 'http',
  url: 'https://mirror.example.net/tdf/LibreOffice.dmg',
  name: 'LibreOffice.dmg',
  size: 300,
  ...fields
})

describe('the same link', () => {
  it('is the link without its query, or the same site and file name', () => {
    expect(
      findDuplicate([candidate({})], query({ url: `${query({}).url}?sig=new` }), 'link')
    ).toEqual({
      id: 'have',
      how: 'link',
      live: false,
      name: 'LibreOffice.dmg',
      host: 'mirror.example.net',
      size: 300,
      completedAt: 5
    })
    expect(
      findDuplicate(
        [candidate({})],
        query({ url: 'https://mirror.example.net/other/LibreOffice.dmg' }),
        'link'
      )?.how
    ).toBe('link')
    expect(
      findDuplicate(
        [candidate({})],
        query({ url: 'https://elsewhere.org/x.dmg', name: 'x.dmg' }),
        'both'
      )
    ).toBeNull()
  })

  it('says how far one still downloading is', () => {
    expect(
      findDuplicate(
        [candidate({ live: true, percent: 42, completedAt: undefined })],
        query({}),
        'link'
      )
    ).toMatchObject({ live: true, percent: 42 })
  })

  it('is, for a torrent, its info hash', () => {
    const torrent = candidate({
      kind: 'torrent',
      infoHash: 'abc',
      link: 'magnet:?xt=old',
      host: ''
    })
    expect(
      findDuplicate(
        [torrent],
        query({ kind: 'torrent', url: 'magnet:?xt=new', infoHash: 'abc' }),
        'link'
      )?.how
    ).toBe('link')
    expect(
      findDuplicate(
        [torrent],
        query({ kind: 'torrent', url: 'magnet:?xt=new', infoHash: 'zzz' }),
        'link'
      )
    ).toBeNull()
  })

  it('warns of nothing when turned off', () => {
    expect(findDuplicate([candidate({})], query({}), 'off')).toBeNull()
  })
})

describe('the same file from another site', () => {
  const elsewhere = { url: 'https://other.example.org/LibreOffice.dmg', publishedSha256: SHA }

  it('needs its name, size and the SHA-256 that site publishes to match', () => {
    expect(findDuplicate([candidate({})], query(elsewhere), 'both')?.how).toBe('file')
    expect(
      findDuplicate(
        [candidate({})],
        query({ ...elsewhere, publishedSha256: 'b'.repeat(64) }),
        'both'
      )
    ).toBeNull()
    expect(findDuplicate([candidate({})], query({ ...elsewhere, size: 301 }), 'both')).toBeNull()
    expect(findDuplicate([candidate({ sha256: undefined })], query(elsewhere), 'both')).toBeNull()
  })

  it('never on name and size alone, nor when set to Same link, nor for other kinds', () => {
    expect(
      findDuplicate([candidate({})], query({ ...elsewhere, publishedSha256: undefined }), 'both')
    ).toBeNull()
    expect(findDuplicate([candidate({})], query(elsewhere), 'link')).toBeNull()
    expect(
      findDuplicate([candidate({})], query({ ...elsewhere, kind: 'stream' }), 'both')
    ).toBeNull()
    expect(findDuplicate([candidate({})], query({ ...elsewhere, size: null }), 'both')).toBeNull()
  })
})

describe('whether to ask the site for its .sha256', () => {
  const elsewhere = { url: 'https://other.example.org/LibreOffice.dmg' }

  it('only when a finished file like it came from another site, and nothing is published yet', () => {
    expect(worthAskingForDigest([candidate({})], query(elsewhere), 'both')).toBe(true)
    expect(worthAskingForDigest([candidate({})], query({}), 'both')).toBe(false)
    expect(worthAskingForDigest([candidate({ live: true })], query(elsewhere), 'both')).toBe(false)
    expect(worthAskingForDigest([candidate({ sha256: undefined })], query(elsewhere), 'both')).toBe(
      false
    )
    expect(
      worthAskingForDigest([candidate({})], query({ ...elsewhere, publishedSha256: SHA }), 'both')
    ).toBe(false)
    expect(worthAskingForDigest([candidate({})], query(elsewhere), 'link')).toBe(false)
    expect(worthAskingForDigest([candidate({})], query({ ...elsewhere, size: null }), 'both')).toBe(
      false
    )
  })
})

describe('the setting', () => {
  it('is off, same link, or link or file', () => {
    expect(['off', 'link', 'both'].every(isDuplicateCheck)).toBe(true)
    expect(isDuplicateCheck('file')).toBe(false)
  })
})
