import { describe, expect, it } from 'vitest'
import {
  fileNameOfLink,
  isRefusal,
  isWebLink,
  linkStopped,
  signedLink,
  type Refusals
} from './linkExpiry'

const refusals = (fields: Partial<Refusals> = {}): Refusals => ({
  status: 403,
  signed: false,
  count: 1,
  networks: 1,
  usable: 2,
  ...fields
})

describe('a signed link', () => {
  it('is told by the keys S3, CloudFront, Google, Azure and others sign with', () => {
    for (const url of [
      'https://bucket.s3.amazonaws.com/a.iso?X-Amz-Expires=3600&X-Amz-Signature=abc',
      'https://d111.cloudfront.net/a.iso?Expires=1&Signature=x&Key-Pair-Id=K',
      'https://storage.googleapis.com/b/a.iso?X-Goog-Expires=600&X-Goog-Signature=x',
      'https://acct.blob.core.windows.net/c/a.iso?sv=2024&se=2026-01-01&sig=x',
      'https://files.example.com/a.iso?token=abc',
      'https://files.example.com/a.iso?exp=1700000000'
    ]) {
      expect(signedLink(url), url).toBe(true)
    }
  })

  it('is not one without such a key, or not a link at all', () => {
    expect(signedLink('https://files.example.com/a.iso')).toBe(false)
    expect(signedLink('https://files.example.com/a.iso?version=2&lang=en')).toBe(false)
    expect(signedLink('not a link')).toBe(false)
  })
})

describe('when a link has stopped working', () => {
  it('counts only the answers that refuse the link', () => {
    expect([401, 403, 410].every(isRefusal)).toBe(true)
    expect([200, 404, 416, 429, 500].some(isRefusal)).toBe(false)
  })

  it('a signed link refused twice in a row has', () => {
    expect(linkStopped(refusals({ signed: true, count: 1 }))).toBe(false)
    expect(linkStopped(refusals({ signed: true, count: 2 }))).toBe(true)
    expect(linkStopped(refusals({ signed: true, status: 401, count: 2 }))).toBe(true)
    expect(linkStopped(refusals({ signed: true, status: 410, count: 3 }))).toBe(true)
  })

  it('any other needs three in a row, on every network it can use', () => {
    expect(linkStopped(refusals({ count: 3, networks: 1, usable: 2 }))).toBe(false)
    expect(linkStopped(refusals({ count: 2, networks: 2, usable: 2 }))).toBe(false)
    expect(linkStopped(refusals({ count: 3, networks: 2, usable: 2 }))).toBe(true)
    expect(linkStopped(refusals({ count: 3, networks: 1, usable: 1 }))).toBe(true)
    // With no network usable (they all dropped), one that refused is enough to count.
    expect(linkStopped(refusals({ count: 3, networks: 1, usable: 0 }))).toBe(true)
  })

  it('never on other answers: not found, too many requests, a server error', () => {
    for (const status of [404, 416, 429, 500, 503]) {
      expect(linkStopped(refusals({ status, signed: true, count: 9, networks: 2 }))).toBe(false)
    }
  })
})

describe('reading a pasted link', () => {
  it('takes the file name from its path, decoded', () => {
    expect(fileNameOfLink('https://x.example.com/s/ab/Big%20File.zip?sig=1')).toBe('Big File.zip')
    expect(fileNameOfLink('https://x.example.com/')).toBe('')
    expect(fileNameOfLink('nonsense')).toBe('')
    expect(fileNameOfLink('https://x.example.com/%E0%A4%A')).toBe('')
  })

  it('knows a web link from anything else', () => {
    expect(isWebLink('  https://files.example.com/a.iso  ')).toBe(true)
    expect(isWebLink('http://files.example.com/a.iso')).toBe(true)
    expect(isWebLink('ftp://files.example.com/a.iso')).toBe(false)
    expect(isWebLink('https://localhost/a.iso')).toBe(false)
    expect(isWebLink('files.example.com/a.iso')).toBe(false)
    expect(isWebLink('')).toBe(false)
  })
})
