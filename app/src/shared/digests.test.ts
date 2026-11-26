import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { publishedSha256, sha256FromFile } from './digests'

const hex = createHash('sha256').update('the file').digest('hex')
const base64 = Buffer.from(hex, 'hex').toString('base64')

describe('a published SHA-256 in the headers', () => {
  it('reads Repr-Digest, among other algorithms', () => {
    expect(publishedSha256({ reprDigest: `sha-256=:${base64}:` })).toBe(hex)
    expect(publishedSha256({ reprDigest: `sha-512=:AAAA:, sha-256=:${base64}:` })).toBe(hex)
  })

  it('reads the older Digest, as raw bytes or as hex, whatever its case', () => {
    expect(publishedSha256({ digest: `SHA-256=${base64}` })).toBe(hex)
    expect(publishedSha256({ digest: `md5=HUXZLQLMuI/KZ5KDcJPcOA==, sha-256=${base64}` })).toBe(hex)
    // RFC 5843's own example: base64 of the hex text.
    expect(publishedSha256({ digest: `SHA-256=${btoa(hex.toUpperCase())}` })).toBe(hex)
  })

  it('prefers Repr-Digest, and takes nothing that isn’t a SHA-256', () => {
    const other = createHash('sha256').update('other').digest('base64')
    expect(publishedSha256({ reprDigest: `sha-256=:${base64}:`, digest: `SHA-256=${other}` })).toBe(
      hex
    )
    expect(publishedSha256({})).toBeUndefined()
    expect(publishedSha256({ reprDigest: null, digest: null })).toBeUndefined()
    expect(publishedSha256({ reprDigest: 'sha-512=:AAAA:' })).toBeUndefined()
    expect(publishedSha256({ reprDigest: 'sha-256=:AAAA:' })).toBeUndefined()
    expect(publishedSha256({ digest: 'SHA=thvDyvhfIqlvFe+A9MYgxAfm1q5=' })).toBeUndefined()
    expect(publishedSha256({ digest: 'sha-256' })).toBeUndefined()
    expect(publishedSha256({ digest: 'sha-256=not base64!' })).toBeUndefined()
  })
})

describe('a .sha256 file beside the download', () => {
  it('reads the digest alone, sha256sum’s lines and BSD’s, for this file only', () => {
    expect(sha256FromFile(`${hex}\n`, 'a.iso')).toBe(hex)
    expect(sha256FromFile(`${'0'.repeat(64)}  b.iso\n${hex}  a.iso`, 'a.iso')).toBe(hex)
    expect(sha256FromFile(`${hex.toUpperCase()} *a.iso`, 'a.iso')).toBe(hex)
    expect(
      sha256FromFile(`SHA256 (b.iso) = ${'1'.repeat(64)}\nSHA256 (a.iso) = ${hex}`, 'a.iso')
    ).toBe(hex)
  })

  it('finds nothing in a file about others, or in anything else', () => {
    expect(sha256FromFile(`${hex}  b.iso`, 'a.iso')).toBeUndefined()
    expect(sha256FromFile(`SHA256 (b.iso) = ${hex}`, 'a.iso')).toBeUndefined()
    expect(sha256FromFile('<html>Not found</html>\n\n', 'a.iso')).toBeUndefined()
  })
})
