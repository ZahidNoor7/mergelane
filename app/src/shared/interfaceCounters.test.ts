import { describe, expect, it } from 'vitest'
import { parseInterfaceList, RTM_IFINFO2, trafficRates } from './interfaceCounters'

// The adapters' byte counters from sysctl NET_RT_IFLIST2 (ADR-0070), laid out as the macOS SDK has them.

/** One message: if_msghdr2 (32 bytes) and if_data64 (ibytes at 64, obytes at 72), as macOS sends it. */
function message(
  type: number,
  index: number,
  ibytes: bigint,
  obytes: bigint,
  length = 152
): Buffer {
  const buffer = Buffer.alloc(length)
  buffer.writeUInt16LE(length, 0)
  buffer.writeUInt8(5, 2)
  buffer.writeUInt8(type, 3)
  buffer.writeUInt16LE(index, 12)
  if (length >= 112) {
    buffer.writeBigUInt64LE(ibytes, 96)
    buffer.writeBigUInt64LE(obytes, 104)
  }
  return buffer
}

describe('parseInterfaceList', () => {
  it('reads each adapter’s 64-bit counters by its index, skipping other messages', () => {
    const list = Buffer.concat([
      message(RTM_IFINFO2, 14, 312_342_528n, 166_384_640n),
      // An address message for the same adapter (RTM_NEWMADDR2), not counters.
      message(0x13, 14, 1n, 1n, 40),
      // Past 4 GB: the 64-bit counters don't wrap.
      message(RTM_IFINFO2, 1, 6_000_000_000n, 5_000_000_000n)
    ])
    expect(parseInterfaceList(list)).toEqual(
      new Map([
        [14, { rx: 312_342_528, tx: 166_384_640 }],
        [1, { rx: 6_000_000_000, tx: 5_000_000_000 }]
      ])
    )
  })

  it('stops at a message that doesn’t fit, or makes no sense, and skips one too short for counters', () => {
    const whole = message(RTM_IFINFO2, 4, 10n, 20n)
    // The next message claims more bytes than are left.
    const cut = message(RTM_IFINFO2, 5, 1n, 1n).subarray(0, 60)
    expect(parseInterfaceList(Buffer.concat([whole, cut]))).toEqual(
      new Map([[4, { rx: 10, tx: 20 }]])
    )
    const zero = Buffer.alloc(8)
    expect(parseInterfaceList(Buffer.concat([zero, whole]))).toEqual(new Map())
    expect(parseInterfaceList(message(RTM_IFINFO2, 6, 1n, 1n, 100))).toEqual(new Map())
    expect(parseInterfaceList(new Uint8Array(2))).toEqual(new Map())
  })

  it('reads from the middle of a larger buffer', () => {
    const list = Buffer.concat([Buffer.alloc(16), message(RTM_IFINFO2, 9, 7n, 8n)])
    expect(parseInterfaceList(list.subarray(16))).toEqual(new Map([[9, { rx: 7, tx: 8 }]]))
  })
})

describe('trafficRates', () => {
  const before = new Map([
    ['en0', { rx: 1_000, tx: 500 }],
    ['en7', { rx: 9_000, tx: 9_000 }]
  ])

  it('is each adapter’s change a second', () => {
    const after = new Map([
      ['en0', { rx: 3_000, tx: 1_500 }],
      ['en7', { rx: 9_000, tx: 9_000 }]
    ])
    expect(trafficRates(before, after, 2)).toEqual({
      en0: { rx: 1_000, tx: 500 },
      en7: { rx: 0, tx: 0 }
    })
  })

  it('has no speed for an adapter seen once, one whose counters went back, or no time passed', () => {
    const after = new Map([
      ['en0', { rx: 10, tx: 5_000 }],
      ['en5', { rx: 100, tx: 100 }]
    ])
    expect(trafficRates(before, after, 1)).toEqual({})
    expect(trafficRates(before, before, 0)).toEqual({})
  })
})
