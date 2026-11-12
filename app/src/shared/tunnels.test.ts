import { describe, expect, it } from 'vitest'
import { isMacTunnel } from './tunnels'

describe('isMacTunnel', () => {
  it('knows macOS tunnels by name', () => {
    for (const device of ['utun0', 'utun12', 'ipsec0', 'ppp0', 'gif0', 'stf0', 'tun1', 'tap3']) {
      expect(isMacTunnel(device), device).toBe(true)
    }
  })

  it('leaves real networks, and lookalikes, alone', () => {
    for (const device of [
      'en0',
      'en7',
      'bridge0',
      'awdl0',
      'llw0',
      'anpi0',
      'utun',
      'xutun0',
      'utun0a'
    ]) {
      expect(isMacTunnel(device), device).toBe(false)
    }
  })
})
