import type { SpeedTestLinkResult, SpeedTestRun } from '@shared/speedTest'
import { describe, expect, it } from 'vitest'
import {
  change,
  dialMax,
  downloadTrend,
  formatMs,
  formatWhen,
  noteText,
  phaseLabel,
  previousRow,
  resultRows,
  scopeLabel,
  SCOPE_CHOICES,
  testedNetworks,
  TOTAL
} from './speedTest'

const link = (overrides: Partial<SpeedTestLinkResult> = {}): SpeedTestLinkResult => ({
  networkId: 'en0',
  kind: 'wifi',
  name: 'Wi-Fi',
  status: 'done',
  latencySamples: 20,
  bytesDown: 0,
  bytesUp: 0,
  ...overrides
})

const run = (overrides: Partial<SpeedTestRun> = {}): SpeedTestRun => ({
  id: 'r',
  scope: 'link',
  server: 'https://speed.cloudflare.com',
  startedAt: 1_000,
  finishedAt: 2_000,
  status: 'done',
  links: [],
  notes: [],
  ...overrides
})

describe('words', () => {
  it('names each kind of test and each phase', () => {
    expect(SCOPE_CHOICES.map((choice) => scopeLabel(choice.scope))).toEqual([
      'Each network',
      'All together',
      'Other apps'
    ])
    expect(scopeLabel('nope' as never)).toBe('nope')
    expect(['latency', 'download', 'upload'].map((phase) => phaseLabel(phase as never))).toEqual([
      'Ping',
      'Download',
      'Upload'
    ])
  })

  it('says what each note means', () => {
    expect(noteText('downloads-paused')).toMatch(/^Your downloads were paused/)
    expect(noteText('downloads-paused', 1)).toMatch(/^Your download was paused/)
    expect(noteText('downloads-paused', 3)).toMatch(/^Your 3 downloads were paused/)
    expect(noteText('busy-network')).toMatch(/may be low/)
    expect(noteText('sticky-sites-on')).toMatch(/one network’s speed/)
    expect(noteText('speed-limit')).toMatch(/speed limit/)
  })

  it('formats milliseconds, with a tenth below 10', () => {
    expect(formatMs(undefined)).toBe('—')
    expect(formatMs(Number.NaN)).toBe('—')
    expect(formatMs(4.26)).toBe('4.3 ms')
    expect(formatMs(23.6)).toBe('24 ms')
  })

  it('says when, from today', () => {
    const now = new Date(2026, 10, 14, 12).getTime()
    expect(formatWhen(new Date(2026, 10, 14, 9, 5).getTime(), now)).toMatch(/^Today, /)
    expect(formatWhen(new Date(2026, 10, 13, 9, 5).getTime(), now)).toMatch(/^Yesterday, /)
    expect(formatWhen(new Date(2026, 10, 2, 9, 5).getTime(), now)).toMatch(/^(2 Nov|Nov 2), /)
  })
})

describe('dialMax', () => {
  const mbps = (bytes: number): number => (bytes * 8) / 1_000_000
  it('starts at 5 Mbps and steps up past the fastest reading, with room to spare', () => {
    expect(mbps(dialMax(0))).toBe(5)
    expect(mbps(dialMax(-3))).toBe(5)
    expect(mbps(dialMax((9 * 1_000_000) / 8))).toBe(10)
    expect(mbps(dialMax((10 * 1_000_000) / 8))).toBe(25)
    expect(mbps(dialMax((900 * 1_000_000) / 8))).toBe(1_000)
  })

  it('rounds past the last step to the next 10 Gbps', () => {
    expect(mbps(dialMax((12_000 * 1_000_000) / 8))).toBe(20_000)
  })
})

describe('comparing', () => {
  it('works out a change as a whole percentage, when there is one', () => {
    expect(change(undefined, 5)).toBeUndefined()
    expect(change(5, undefined)).toBeUndefined()
    expect(change(5, 0)).toBeUndefined()
    expect(change(110, 100)).toBe(10)
    expect(change(75, 100)).toBe(-25)
  })

  it('lists the total first, then each network', () => {
    const together = run({
      scope: 'combined',
      combined: { downloadBytesPerSec: 9, share: {} },
      links: [link({ downloadBytesPerSec: 4 })]
    })
    expect(resultRows(together).map((row) => [row.key, row.downloadBytesPerSec])).toEqual([
      [TOTAL, 9],
      ['en0', 4]
    ])
    expect(resultRows(run({ links: [link()] })).map((row) => row.key)).toEqual(['en0'])
  })

  it('compares with the latest earlier finished run of the same kind', () => {
    const now = run({ id: 'now', startedAt: 5_000, links: [link({ downloadBytesPerSec: 10 })] })
    const runs = [
      now,
      // Later than `now`, another kind, failed, or without the network finished: skipped.
      run({ id: 'later', startedAt: 6_000, links: [link({ downloadBytesPerSec: 1 })] }),
      run({ id: 'other', scope: 'combined', startedAt: 4_500, combined: { share: {} } }),
      run({ id: 'failed', startedAt: 4_400, status: 'failed', links: [link()] }),
      run({ id: 'not-it', startedAt: 4_300, links: [link({ networkId: 'en5' })] }),
      run({ id: 'dropped', startedAt: 4_200, links: [link({ status: 'failed' })] }),
      run({ id: 'before', startedAt: 4_000, links: [link({ downloadBytesPerSec: 8 })] })
    ]
    expect(previousRow(runs, now, 'en0')?.downloadBytesPerSec).toBe(8)
    expect(previousRow(runs, now, 'en9')).toBeUndefined()

    const total = run({ id: 't', scope: 'combined', startedAt: 9_000, combined: { share: {} } })
    const earlier = run({
      id: 'e',
      scope: 'combined',
      startedAt: 8_000,
      combined: { downloadBytesPerSec: 3, share: {} }
    })
    expect(previousRow([total, earlier], total, TOTAL)?.downloadBytesPerSec).toBe(3)
  })

  it('gives a network’s download trend oldest first, finished tests only, at most `count`', () => {
    const runs = [3, 2, 1].map((speed) =>
      run({ id: `r${speed}`, links: [link({ downloadBytesPerSec: speed })] })
    )
    runs.splice(1, 0, run({ links: [link({ status: 'failed', downloadBytesPerSec: 99 })] }))
    expect(downloadTrend(runs, 'en0')).toEqual([1, 2, 3])
    expect(downloadTrend(runs, 'en0', 2)).toEqual([2, 3])
    expect(downloadTrend(runs, 'en9')).toEqual([])
  })

  it('lists each tested network once, as the newest run names it', () => {
    const runs = [
      run({ links: [link({ name: 'Newer' }), link({ networkId: 'en1' })] }),
      run({ links: [link({ name: 'Older' })] })
    ]
    expect(testedNetworks(runs).map((each) => [each.networkId, each.name])).toEqual([
      ['en0', 'Newer'],
      ['en1', 'Wi-Fi']
    ])
  })
})
