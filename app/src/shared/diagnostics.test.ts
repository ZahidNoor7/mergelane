import { describe, expect, it } from 'vitest'
import {
  addressScope,
  buildDiagnostics,
  diagnosticsFileName,
  diagnosticsReadme,
  fileType,
  HELPER_LOG_LINES,
  HISTORY_IN_BUNDLE,
  redactIdentity,
  redactLog,
  redactStrings,
  redactText,
  redactUrl,
  summarizeDownload,
  type DiagnosticsInput,
  type RedactionContext
} from './diagnostics'
import type { DownloadUpdate, FinishedDownload, SystemMergeSnapshot } from './types'

const context: RedactionContext = { home: '/Users/alexsmith', userName: 'alexsmith' }
const NOW = new Date(2026, 10, 11, 14, 30).getTime()

// Everything a bundle must never hold, planted across the input below.
const SECRETS = [
  'token=s3cr3t',
  's3cr3t',
  'sig=abc123',
  'hunter2',
  'proxy.example.net',
  'proxyuser',
  'news.example.org',
  'newsuser',
  'Cookie',
  'session=deadbeef',
  'tax-return-2026',
  'Taxes',
  '/Users/alexsmith',
  'alexsmith',
  'alex@example.com',
  '203.0.113.7',
  '2001:db8:1234::42',
  'a4:83:e7:11:22:33',
  'My secret hotspot',
  'xt=urn:btih',
  'private-share-id'
]

const httpDownload = {
  id: 'd1',
  kind: 'http',
  url: 'https://user:hunter2@cdn.example.com/private-share-id/tax-return-2026.pdf?token=s3cr3t&sig=abc123',
  fileName: 'tax-return-2026.pdf',
  destinationPath: '/Users/alexsmith/Documents/Taxes/tax-return-2026.pdf',
  totalBytes: 1000,
  bytesDownloaded: 400,
  speedBytesPerSec: 50,
  status: 'error',
  error:
    'Couldn’t write /Users/alexsmith/Documents/Taxes/tax-return-2026.pdf from https://cdn.example.com/x?token=s3cr3t via 203.0.113.7',
  resumable: true,
  startedAt: NOW - 60_000,
  peakSpeedBytesPerSec: 80,
  fromBrowser: 'Chrome',
  networks: [
    {
      id: 'en0',
      label: 'My secret hotspot',
      kind: 'wifi',
      enabled: true,
      status: 'failed',
      error: 'connect ECONNREFUSED 203.0.113.7:443',
      bytesDownloaded: 400,
      speedBytesPerSec: 50,
      retries: 2,
      transfer: 'http'
    }
  ],
  streams: [{}, {}],
  peakStreams: 4,
  totalBlocks: 8,
  blockSizeBytes: 125,
  // A browser's sign-in, as a download received from the extension might carry it.
  browser: { headers: { Cookie: 'session=deadbeef' } }
} as unknown as DownloadUpdate['state']

const torrent = {
  id: 't1',
  kind: 'torrent',
  url: 'magnet:?xt=urn:btih:0123456789abcdef&dn=tax-return-2026',
  fileName: 'tax-return-2026',
  destinationPath: '/Users/alexsmith/Downloads/tax-return-2026',
  totalBytes: 2000,
  bytesDownloaded: 2000,
  speedBytesPerSec: 0,
  status: 'completed',
  startedAt: NOW - 120_000,
  completedAt: NOW - 60_000,
  networks: [],
  peakPeers: 7,
  totalPieces: 16,
  unitsWritten: 16,
  missing: true
} as unknown as FinishedDownload

const helper: SystemMergeSnapshot = {
  installed: true,
  reachable: true,
  state: 'off',
  reason: 'another VPN routes 203.0.113.7',
  error: 'socket at /Users/alexsmith/x failed',
  links: [{ name: 'en0', state: 'up', rxBps: 1, txBps: 2, activeFlows: 3 }],
  appVersion: '0.2.0',
  helperVersion: '0.2.0',
  helperOutdated: false,
  autoResume: true,
  stickySites: true,
  events: [],
  outages: []
}

const input: DiagnosticsInput = {
  generatedAt: NOW,
  app: {
    version: '0.2.0',
    packaged: true,
    electron: '44.0.0',
    chrome: '146.0.7680.31',
    node: '24.1.0',
    translated: false
  },
  system: {
    platform: 'darwin',
    arch: 'arm64',
    machine: 'arm64',
    macOS: '27.0.0',
    darwin: '27.0.0',
    cpu: 'Apple M1',
    cpuCount: 8,
    memoryBytes: 16 * 1024 ** 3
  },
  helper,
  networks: [
    {
      id: 'en0',
      device: 'en0',
      displayName: 'Wi-Fi',
      kind: 'wifi',
      mac: 'a4:83:e7:11:22:33',
      addresses: [
        { address: '192.168.1.20', family: 4, netmask: '255.255.255.0' },
        { address: '2001:db8:1234::42', family: 6 }
      ]
    }
  ],
  activity: {
    events: [{ id: 'en7', osName: 'iPhone USB', kind: 'usb', change: 'dropped', at: NOW, left: 1 }],
    fastest: { day: '2026-11-11', bytesPerSec: 123 }
  },
  settings: {
    themeSource: 'dark',
    speedUnit: 'bits',
    destinationDir: '/Users/alexsmith/Documents/Taxes',
    updateLastChecked: NOW,
    downloadSchedule: { enabled: true, startMinute: 60, endMinute: 120, days: [1, 2] },
    captureRules: { capture: true, minSize: '1mb', types: ['video'], videoButton: false },
    routing: { down: 'en0', up: 'en7', fallback: false },
    uploadLimit: 50_000,
    offerCopiedLinks: true,
    browserContacts: { chrome: { at: NOW, extension: '0.3.0' } },
    networkPreferences: {
      en7: {
        customName: 'My secret hotspot',
        colorId: 'blue',
        dataLimit: 5,
        uploadLimit: 20_000,
        proxy: {
          enabled: true,
          type: 'socks5',
          host: 'proxy.example.net',
          port: 1080,
          username: 'proxyuser',
          password: 'hunter2'
        }
      }
    }
  },
  usenet: {
    enabled: true,
    host: 'news.example.org',
    port: 563,
    tls: true,
    username: 'newsuser',
    connections: 10,
    hasPassword: true
  },
  downloads: [httpDownload],
  history: [torrent]
}

describe('redaction', () => {
  it('a link keeps only its scheme and site', () => {
    expect(redactUrl('https://user:pw@cdn.example.com:8443/a/b.zip?token=1#x')).toBe(
      'https://cdn.example.com:8443/…'
    )
    expect(redactUrl('https://example.com/')).toBe('https://example.com/')
    expect(redactUrl('https://example.com/?q=1')).toBe('https://example.com/…')
    expect(redactUrl('magnet:?xt=urn:btih:abc')).toBe('magnet:…')
    expect(redactUrl('file:///Users/alexsmith/a.torrent')).toBe('file:…')
    expect(redactUrl('not a link')).toBe('[link]')
  })

  it('text loses links, emails, the home folder, the account name and public addresses', () => {
    expect(
      redactText(
        'GET https://x.com/a?k=1 for alex@example.com in /Users/alexsmith/Movies and /Users/bob/x, by alexsmith; magnet:?xt=urn:btih:1 at 203.0.113.7, 192.168.1.2, 10.0.0.1, fe80::1, 2001:db8::1, a4:83:e7:11:22:33 at 12:30:45 v1.2.3',
        context
      )
    ).toBe(
      'GET https://x.com/… for <email> in ~/… and /Users/<user>/…, by <user>; magnet:… at <ip>, 192.168.1.2, 10.0.0.1, fe80::1, <ip>, <ip> at 12:30:45 v1.2.3'
    )
    // Not an address: a number over 255.
    expect(redactText('build 300.1.1.1', context)).toBe('build 300.1.1.1')
  })

  it('a short or missing account name is left alone, as is /Users/Shared', () => {
    expect(redactIdentity('al is in /Users/Shared/x', { home: '/', userName: 'al' })).toBe(
      'al is in /Users/Shared/x'
    )
    expect(redactIdentity('/Users/alexsmith2/x', { home: '/Users/alexsmith' })).toBe(
      '/Users/<user>/…'
    )
  })

  it('every string at any depth goes through the second net', () => {
    expect(
      redactStrings({ a: ['/Users/alexsmith/x', 3, null, { b: 'alexsmith' }], c: true }, context)
    ).toEqual({ a: ['~/…', 3, null, { b: '<user>' }], c: true })
  })

  it('addresses keep only their scope', () => {
    expect(addressScope('127.0.0.1', 4)).toBe('loopback')
    expect(addressScope('169.254.3.4', 4)).toBe('link-local')
    expect(addressScope('172.20.1.1', 4)).toBe('private')
    expect(addressScope('172.32.1.1', 4)).toBe('public')
    expect(addressScope('100.70.1.1', 4)).toBe('shared')
    expect(addressScope('::1', 6)).toBe('loopback')
    expect(addressScope('fe80::1', 6)).toBe('link-local')
    expect(addressScope('fd00::1', 6)).toBe('private')
    expect(addressScope('2001:db8::1', 6)).toBe('public')
  })

  it('a file keeps only its type', () => {
    expect(fileType('Tax Return.PDF')).toBe('pdf')
    expect(fileType('folder')).toBe('')
  })
})

describe('the bundle', () => {
  const report = buildDiagnostics(input, context)
  const text = JSON.stringify(report)

  it('holds none of the secrets planted in its input', () => {
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret)
  })

  it('holds what helps: versions, the Mac, the networks, the helper, settings and downloads', () => {
    expect(report.app).toMatchObject({ version: '0.2.0', electron: '44.0.0', translated: false })
    expect(report.system).toMatchObject({ arch: 'arm64', macOS: '27.0.0', cpuCount: 8 })
    expect(report.networks).toEqual([
      {
        id: 'en0',
        kind: 'wifi',
        name: 'Wi-Fi',
        addresses: [
          { family: 4, scope: 'private' },
          { family: 6, scope: 'public' }
        ]
      }
    ])
    expect(report.helper).toMatchObject({
      installed: true,
      state: 'off',
      reason: 'another VPN routes <ip>',
      error: 'socket at ~/… failed',
      autoResume: true,
      stickySites: true,
      links: helper.links
    })
    expect(report.networkActivity).toEqual(input.activity)
    expect(report.settings).toMatchObject({
      themeSource: 'dark',
      speedUnit: 'bits',
      destination: 'a folder in the home folder',
      routing: { down: 'en0', up: 'en7', fallback: false },
      uploadLimit: 50_000,
      offerCopiedLinks: true,
      browsers: { chrome: { extension: '0.3.0' } },
      networks: {
        en7: {
          renamed: true,
          colorId: 'blue',
          dataLimit: 5,
          uploadLimit: 20_000,
          proxy: { enabled: true, type: 'socks5', signIn: true }
        }
      }
    })
    expect(report.usenet).toEqual({
      configured: true,
      enabled: true,
      tls: true,
      port: 563,
      connections: 10,
      hasPassword: true
    })
    expect(report.downloads).toEqual([
      {
        id: 'd1',
        kind: 'http',
        status: 'error',
        site: 'https://cdn.example.com/…',
        fileType: 'pdf',
        totalBytes: 1000,
        bytesDownloaded: 400,
        speedBytesPerSec: 50,
        peakSpeedBytesPerSec: 80,
        startedAt: new Date(NOW - 60_000).toISOString(),
        error: 'Couldn’t write <file> from https://cdn.example.com/… via <ip>',
        resumable: true,
        fromBrowser: true,
        parts: 8,
        connections: 2,
        peakConnections: 4,
        networks: [
          {
            id: 'en0',
            kind: 'wifi',
            enabled: true,
            status: 'failed',
            bytesDownloaded: 400,
            retries: 2,
            error: 'connect ECONNREFUSED <ip>:443'
          }
        ]
      }
    ])
    expect(report.history).toEqual({
      total: 1,
      newest: [
        expect.objectContaining({
          kind: 'torrent',
          site: 'magnet:…',
          fileType: '',
          missing: true,
          parts: 16,
          peakConnections: 7,
          completedAt: new Date(NOW - 60_000).toISOString()
        })
      ]
    })
  })

  it('a path in free text keeps only where it starts', () => {
    expect(
      redactText('open /Users/alexsmith/My Taxes/a.pdf; /Volumes/Backup/b, /tmp/c', context)
    ).toBe('open ~/… Taxes/a.pdf; /Volumes/…, /tmp/c')
  })

  it('leaves out what it can’t have, and lists at most HISTORY_IN_BUNDLE finished downloads', () => {
    const bare = buildDiagnostics(
      {
        ...input,
        helper: null,
        usenet: null,
        settings: { destinationDir: '/Volumes/Backup/x' },
        history: Array(HISTORY_IN_BUNDLE + 5).fill(torrent)
      },
      { home: '/Users/alexsmith' }
    )
    expect(bare.helper).toEqual({ error: 'The helper could not be asked.' })
    expect(bare.usenet).toEqual({ configured: false })
    expect(bare.settings).toMatchObject({ destination: 'a folder on another disk' })
    const history = bare.history as { total: number; newest: unknown[] }
    expect(history.total).toBe(HISTORY_IN_BUNDLE + 5)
    expect(history.newest).toHaveLength(HISTORY_IN_BUNDLE)
    expect(
      buildDiagnostics({ ...input, settings: { destinationDir: '/opt/x' } }, context).settings
    ).toMatchObject({ destination: 'a folder elsewhere' })
    expect(buildDiagnostics({ ...input, settings: {} }, context).settings).toMatchObject({
      destination: 'Downloads (default)'
    })
  })

  it('a download without an error or browser says nothing of them', () => {
    const summary = summarizeDownload(
      { ...httpDownload, error: undefined, networks: [] } as unknown as DownloadUpdate['state'],
      context
    )
    expect(summary.error).toBeUndefined()
    expect(summarizeDownload(torrent, context).fromBrowser).toBeUndefined()
  })
})

describe('the helper’s log', () => {
  it('keeps its last lines, redacted', () => {
    const lines = Array.from({ length: HELPER_LOG_LINES + 10 }, (_, index) => `line ${index}`)
    lines.push('routing for alexsmith over 203.0.113.7')
    const kept = redactLog(`${lines.join('\n')}\n`, context).split('\n')
    expect(kept).toHaveLength(HELPER_LOG_LINES)
    expect(kept.at(-1)).toBe('routing for <user> over <ip>')
    expect(kept[0]).toBe('line 11')
  })
})

describe('the bundle’s files', () => {
  it('is named for the moment it was made', () => {
    expect(diagnosticsFileName(NOW)).toBe('Mergelane-Diagnostics-2026-11-11-1430.zip')
  })

  it('says what it holds and what was left out', () => {
    const readme = diagnosticsReadme(NOW, true)
    expect(readme).toContain('Mergelane never sends this anywhere')
    expect(readme).toContain('helper-log.txt')
    expect(diagnosticsReadme(NOW, false)).toContain('No helper log')
  })
})
