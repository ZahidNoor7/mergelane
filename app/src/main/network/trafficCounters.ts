import {
  parseInterfaceList,
  trafficRates,
  type Octets,
  type TrafficRate
} from '../../shared/interfaceCounters'

// Each network's speed from every app on the Mac, for the Dashboard's "Total speed, all apps" (docs/DECISIONS.md
// ADR-0070): the kernel's own byte counters per adapter, read with sysctl NET_RT_IFLIST2 through libc (koffi), as
// mergelane-daemon reads them (daemon/internal/nics/counters_darwin.go). Unprivileged, so it needs no helper and
// works with System merge off. The Mac only for now: Windows answers null and its Dashboard keeps the merged
// download speed.

/** <sys/sysctl.h> CTL_NET, <sys/socket.h> PF_ROUTE and NET_RT_IFLIST2: every adapter (index 0), in one buffer. */
const MIB = [4, 17, 0, 0, 6, 0]

/** Two readings closer than this give the last speeds again, so the Dashboard and anything else asking at once
 * share one reading. */
const MIN_INTERVAL_MS = 900

/** Readings further apart than this (nothing asked for a while) would give an average over the gap, not a speed
 * now: the later one starts again. */
const MAX_INTERVAL_MS = 5000

type Reader = (names: readonly string[]) => Map<string, Octets> | null

/** The Mac's counters, by adapter name; null where they can't be read. */
async function darwinReader(): Promise<Reader | null> {
  const { default: koffi } = await import('koffi')
  const lib = koffi.load('/usr/lib/libSystem.B.dylib')
  const sysctl = lib.func(
    'int sysctl(const void *, uint32_t, _Out_ void *, _Inout_ size_t *, const void *, size_t)'
  )
  const ifNameToIndex = lib.func('uint32_t if_nametoindex(const char *)')
  const mib = Buffer.alloc(MIB.length * 4)
  MIB.forEach((value, i) => mib.writeInt32LE(value, i * 4))
  return (names) => {
    const size = [0]
    if (sysctl(mib, MIB.length, null, size, null, 0) !== 0) return null
    // Room for an adapter that turns up between the two calls.
    const buffer = Buffer.alloc((size[0] as number) + 4096)
    const length = [buffer.length]
    if (sysctl(mib, MIB.length, buffer, length, null, 0) !== 0) return null
    const byIndex = parseInterfaceList(buffer.subarray(0, length[0] as number))
    const counters = new Map<string, Octets>()
    for (const name of names) {
      const octets = byIndex.get(ifNameToIndex(name) as number)
      if (octets) counters.set(name, octets)
    }
    return counters
  }
}

export class NetworkTraffic {
  private reader: Promise<Reader | null> | null = null
  private last: { at: number; counters: Map<string, Octets> } | null = null
  private rates: Record<string, TrafficRate> = {}

  constructor(
    private readonly makeReader: () => Promise<Reader | null> = () =>
      process.platform === 'darwin' ? darwinReader() : Promise.resolve(null)
  ) {}

  /** Each of `names`' speed now, every app together; null where the counters can't be read. The first reading
   * has nothing to compare with, so it gives no speeds. */
  async sample(
    names: readonly string[],
    now = Date.now()
  ): Promise<Record<string, TrafficRate> | null> {
    this.reader ??= this.makeReader().catch(() => null)
    const read = await this.reader
    if (!read) return null
    if (this.last && now - this.last.at < MIN_INTERVAL_MS) return this.pick(names)
    let counters: Map<string, Octets> | null
    try {
      counters = read(names)
    } catch {
      counters = null
    }
    if (!counters) return null
    const before = this.last
    this.rates =
      before && now - before.at <= MAX_INTERVAL_MS
        ? trafficRates(before.counters, counters, (now - before.at) / 1000)
        : {}
    this.last = { at: now, counters }
    return this.pick(names)
  }

  private pick(names: readonly string[]): Record<string, TrafficRate> {
    return Object.fromEntries(
      names.filter((name) => this.rates[name]).map((name) => [name, this.rates[name]])
    )
  }
}
