import { describe, expect, it } from 'vitest'
import { acceptedLink, COPIED_LINK_MAX, copiedLink, describeCopiedLink } from './links'

describe('acceptedLink', () => {
  it('takes web and magnet links, and .torrent and .nzb paths, trimmed', () => {
    expect(acceptedLink('  https://example.com/a.zip \n')).toBe('https://example.com/a.zip')
    expect(acceptedLink('HTTP://example.com')).toBe('HTTP://example.com')
    expect(acceptedLink('magnet:?xt=urn:btih:abc')).toBe('magnet:?xt=urn:btih:abc')
    expect(acceptedLink('/Users/me/My file.torrent')).toBe('/Users/me/My file.torrent')
    expect(acceptedLink('C:\\files\\a.NZB')).toBe('C:\\files\\a.NZB')
  })

  it('leaves anything else alone', () => {
    for (const text of ['', 'hello', 'ftp://example.com/a', 'example.com', '/Users/me/a.txt']) {
      expect(acceptedLink(text)).toBeNull()
    }
  })
})

describe('copiedLink', () => {
  it('finds the one link that was copied', () => {
    expect(copiedLink('https://example.com/file.iso\n')).toBe('https://example.com/file.iso')
    expect(copiedLink('magnet:?xt=urn:btih:abc&dn=x')).toBe('magnet:?xt=urn:btih:abc&dn=x')
    expect(copiedLink('/Users/me/Season one.torrent')).toBe('/Users/me/Season one.torrent')
  })

  it('passes over text that only starts with a link, or isn’t one', () => {
    expect(copiedLink('https://example.com/a and some words')).toBeNull()
    expect(copiedLink('https://a.example/1\nhttps://b.example/2')).toBeNull()
    expect(copiedLink('my password')).toBeNull()
    expect(copiedLink('')).toBeNull()
  })

  it('is shortened to what recognises it', () => {
    expect(describeCopiedLink('https://files.example.com/releases/big.iso')).toBe(
      'files.example.com/releases/big.iso'
    )
    expect(describeCopiedLink('https://example.com/')).toBe('example.com')
    expect(describeCopiedLink('magnet:?xt=urn:btih:ab&dn=Big%20Film')).toBe('Big Film')
    expect(describeCopiedLink('magnet:?xt=urn:btih:ab')).toBe('A magnet link')
    expect(describeCopiedLink('/Users/me/Season one.torrent')).toBe('Season one.torrent')
    expect(describeCopiedLink('C:\\files\\a.nzb')).toBe('a.nzb')
    // Not a link a URL can be made of: as it is.
    expect(describeCopiedLink('http://[bad')).toBe('http://[bad')
    expect(describeCopiedLink('/')).toBe('/')
  })

  it('passes over anything too long to be a link', () => {
    const long = `https://example.com/${'a'.repeat(COPIED_LINK_MAX)}`
    expect(copiedLink(long)).toBeNull()
    const longest = `https://example.com/${'a'.repeat(COPIED_LINK_MAX - 20)}`
    expect(copiedLink(longest)).toBe(longest)
  })
})
