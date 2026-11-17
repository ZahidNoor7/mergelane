// Each network adapter's own byte counters, and the speeds they give (the Dashboard's "Total speed, all apps";
// docs/DECISIONS.md ADR-0070). macOS keeps them per adapter for every app's traffic. The main process reads them
// with sysctl NET_RT_IFLIST2 (main/network/trafficCounters.ts), as mergelane-daemon does
// (daemon/internal/nics/counters_darwin.go). Pure, so it is tested on any computer.
//
// The layout, from the macOS SDK: <net/route.h> RTM_IFINFO2 = 0x12; <net/if.h> struct if_msghdr2 is
// u_short ifm_msglen, u_char ifm_version, u_char ifm_type, int ifm_addrs, int ifm_flags, u_short ifm_index (at 12),
// four ints, then struct if_data64 ifm_data at 32; <net/if_var.h> if_data64's u_int64_t ifi_ibytes and ifi_obytes
// sit at 64 and 72 within it. The 64-bit counters matter: if_data's 32-bit ones wrap every 4 GB.

export const RTM_IFINFO2 = 0x12
const OFFSET_TYPE = 3
const OFFSET_INDEX = 12
const OFFSET_IBYTES = 32 + 64
const OFFSET_OBYTES = 32 + 72

/** Bytes an adapter has received and sent since it came up. */
export interface Octets {
  rx: number
  tx: number
}

/** Bytes a second an adapter is receiving and sending, every app together. */
export interface TrafficRate {
  rx: number
  tx: number
}

/** Each adapter's counters, by its index, from a NET_RT_IFLIST2 buffer. A message that doesn't fit is the end. */
export function parseInterfaceList(buffer: Uint8Array): Map<number, Octets> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const counters = new Map<number, Octets>()
  let at = 0
  while (at + 4 <= buffer.byteLength) {
    const length = view.getUint16(at, true)
    if (length < 4 || at + length > buffer.byteLength) break
    if (view.getUint8(at + OFFSET_TYPE) === RTM_IFINFO2 && length >= OFFSET_OBYTES + 8) {
      counters.set(view.getUint16(at + OFFSET_INDEX, true), {
        rx: Number(view.getBigUint64(at + OFFSET_IBYTES, true)),
        tx: Number(view.getBigUint64(at + OFFSET_OBYTES, true))
      })
    }
    at += length
  }
  return counters
}

/** Each adapter's speed between two readings `seconds` apart, by its name. One seen only once, or whose counters
 * went back (it reconnected), has no speed yet. */
export function trafficRates(
  before: ReadonlyMap<string, Octets>,
  after: ReadonlyMap<string, Octets>,
  seconds: number
): Record<string, TrafficRate> {
  const rates: Record<string, TrafficRate> = {}
  if (!(seconds > 0)) return rates
  for (const [name, now] of after) {
    const then = before.get(name)
    if (!then || now.rx < then.rx || now.tx < then.tx) continue
    rates[name] = { rx: (now.rx - then.rx) / seconds, tx: (now.tx - then.tx) / seconds }
  }
  return rates
}
