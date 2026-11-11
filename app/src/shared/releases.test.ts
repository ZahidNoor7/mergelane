import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  downloadableUrl,
  parseChecksums,
  newestUpdate,
  parseVersion,
  releaseFromGitHub,
  releaseNotes
} from './releases'

// The shape scripts/release/notes.mjs writes: the CHANGELOG section first, then the rest.
const NOTES = `## What's new

A new look for the whole app: seven themes and a sidebar.
Downloads work as in 0.1.0.

### Added

- Seven themes, each with a light and a dark version: Porcelain and
  **High contrast**.
- A Settings screen (⌘, or the foot of the sidebar):
  - General: speed units, slow mode and total speed.
  - Downloads: where downloads go, and a link to each
    network's limits.
- A Networks screen. It lists every network:
  - its connection type;

  System merge is there too.

### Fixed

- Colours that look alike are kept apart ([details](https://example.com)), with \`code\`.

## Requirements

- macOS 27 or later.
`

const release = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.3.0',
  draft: false,
  prerelease: false,
  published_at: '2026-11-20T10:00:00Z',
  html_url: 'https://github.com/ZahidNoor7/mergelane/releases/tag/v0.3.0',
  body: NOTES,
  assets: [
    {
      name: 'Mergelane-0.3.0-arm64.dmg',
      size: 238_836_052,
      browser_download_url: 'https://github.com/x/Mergelane-0.3.0-arm64.dmg'
    },
    { name: 'SHA256SUMS', size: 474, browser_download_url: 'https://github.com/x/SHA256SUMS' },
    {
      name: 'Mergelane-0.3.0-arm64-mac.zip',
      size: 1,
      browser_download_url: 'https://github.com/x/z'
    }
  ],
  ...fields
})

describe('versions', () => {
  it('reads semantic versions, with or without a v, and refuses anything else', () => {
    expect(parseVersion('v1.2.3')).toEqual({ core: [1, 2, 3], pre: [] })
    expect(parseVersion('0.3.0-beta.1+build.7')).toEqual({ core: [0, 3, 0], pre: ['beta', 1] })
    for (const text of ['1.2', '01.2.3', '1.2.3-', 'latest', ''])
      expect(parseVersion(text)).toBeNull()
  })

  it('orders them as semver.org does', () => {
    const ordered = [
      '0.9.9',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.10.0'
    ]
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1], ordered[i])).toBeLessThan(0)
      expect(compareVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0)
    }
    expect(compareVersions('v1.0.0', '1.0.0+build')).toBe(0)
    expect(compareVersions('1.0.0-rc.1', 'v1.0.0-rc.1')).toBe(0)
    expect(compareVersions('nonsense', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('0.0.1', 'nonsense')).toBeGreaterThan(0)
    expect(compareVersions('x', 'y')).toBe(0)
  })
})

describe('releaseNotes', () => {
  it('takes What’s new: its opening paragraph and each top-level point on one line', () => {
    expect(releaseNotes(NOTES)).toEqual({
      summary:
        'A new look for the whole app: seven themes and a sidebar. Downloads work as in 0.1.0.',
      items: [
        'Seven themes, each with a light and a dark version: Porcelain and High contrast.',
        'A Settings screen (⌘, or the foot of the sidebar):',
        'A Networks screen. It lists every network:',
        'Colours that look alike are kept apart (details), with code.'
      ]
    })
  })

  it('without a What’s new heading, reads up to the first section; empty notes give nothing', () => {
    expect(releaseNotes('Small fixes.\r\n\r\n- One fix\r\n\r\n## Install\r\n- Drag it')).toEqual({
      summary: 'Small fixes.',
      items: ['One fix']
    })
    expect(releaseNotes(null)).toEqual({ summary: null, items: [] })
    expect(releaseNotes('- Only a point')).toEqual({ summary: null, items: ['Only a point'] })
  })
})

describe('releaseFromGitHub', () => {
  it('reads the version, dates, page, notes, disk image and checksums', () => {
    expect(releaseFromGitHub(release())).toEqual({
      version: '0.3.0',
      prerelease: false,
      publishedAt: Date.parse('2026-11-20T10:00:00Z'),
      pageUrl: 'https://github.com/ZahidNoor7/mergelane/releases/tag/v0.3.0',
      notes: releaseNotes(NOTES),
      dmg: {
        name: 'Mergelane-0.3.0-arm64.dmg',
        size: 238_836_052,
        url: 'https://github.com/x/Mergelane-0.3.0-arm64.dmg'
      },
      checksumsUrl: 'https://github.com/x/SHA256SUMS'
    })
  })

  it('leaves out drafts and anything that isn’t a release', () => {
    expect(releaseFromGitHub(release({ draft: true }))).toBeNull()
    expect(releaseFromGitHub(release({ draft: undefined }))).toBeNull()
    expect(releaseFromGitHub(release({ tag_name: 'nightly' }))).toBeNull()
    expect(releaseFromGitHub(release({ tag_name: 7 }))).toBeNull()
    expect(releaseFromGitHub(release({ html_url: 'http://github.com/x' }))).toBeNull()
    expect(releaseFromGitHub(null)).toBeNull()
    expect(releaseFromGitHub([])).toBeNull()
  })

  it('copes with missing or odd fields: no date, no body, no image, plain-http links', () => {
    const odd = releaseFromGitHub(
      release({
        published_at: null,
        body: undefined,
        assets: [
          { name: 'Mergelane-0.3.0-arm64.dmg', size: '9', browser_download_url: 'https://x/y' },
          { name: 'SHA256SUMS', browser_download_url: 'http://x/SHA256SUMS' },
          'not an asset'
        ]
      })
    )
    expect(odd).toMatchObject({ publishedAt: null, dmg: null, checksumsUrl: null })
    expect(odd?.notes).toEqual({ summary: null, items: [] })
    expect(releaseFromGitHub(release({ assets: undefined, published_at: 'soon' }))).toMatchObject({
      publishedAt: null,
      dmg: null,
      checksumsUrl: null
    })
  })
})

describe('newestUpdate', () => {
  const list = [
    release({ tag_name: 'v0.2.0' }),
    release({ tag_name: 'v0.3.0' }),
    release({ tag_name: 'v0.4.0-beta.1', prerelease: true }),
    release({ tag_name: 'v0.5.0', draft: true }),
    { not: 'a release' }
  ]

  it('offers the newest on the channel: Stable leaves prereleases out, Beta takes them', () => {
    expect(
      newestUpdate(list, { current: '0.2.0', channel: 'stable', skipped: null })?.version
    ).toBe('0.3.0')
    expect(newestUpdate(list, { current: '0.2.0', channel: 'beta', skipped: null })?.version).toBe(
      '0.4.0-beta.1'
    )
  })

  it('offers nothing when the app is as new or newer, or the newest was skipped', () => {
    expect(newestUpdate(list, { current: '0.3.0', channel: 'stable', skipped: null })).toBeNull()
    expect(newestUpdate(list, { current: '1.0.0', channel: 'beta', skipped: null })).toBeNull()
    expect(newestUpdate(list, { current: '0.2.0', channel: 'stable', skipped: '0.3.0' })).toBeNull()
    expect(newestUpdate([], { current: '0.2.0', channel: 'beta', skipped: null })).toBeNull()
  })

  it('refuses an answer that isn’t a list', () => {
    expect(() =>
      newestUpdate(
        { message: 'API rate limit exceeded' },
        { current: '0.2.0', channel: 'stable', skipped: null }
      )
    ).toThrow('isn’t a list of releases')
  })
})

describe('downloadableUrl', () => {
  it('takes https anywhere, and plain http only from this Mac', () => {
    for (const url of [
      'https://github.com/x',
      'http://127.0.0.1:9/x',
      'http://localhost/x',
      'http://[::1]:8/x'
    ]) {
      expect(downloadableUrl(url)).toBe(true)
    }
    for (const url of ['http://example.com/x', 'ftp://127.0.0.1/x', 'not a url', 7, null]) {
      expect(downloadableUrl(url)).toBe(false)
    }
  })
})

describe('parseChecksums', () => {
  it('reads shasum’s text and binary lines, and skips the rest', () => {
    const a = 'A'.repeat(64)
    const b = 'b'.repeat(64)
    const sums = parseChecksums(
      `${a}  Mergelane-0.3.0-arm64.dmg\r\n${b} *SHA file.zip\nnot a line\n\n`
    )
    expect([...sums]).toEqual([
      ['Mergelane-0.3.0-arm64.dmg', 'a'.repeat(64)],
      ['SHA file.zip', b]
    ])
  })
})
