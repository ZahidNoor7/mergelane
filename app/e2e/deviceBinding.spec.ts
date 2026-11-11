import { expect, test } from '@playwright/test'
import koffi from 'koffi'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  connectFrom,
  connectRoute,
  deviceBindingSupported,
  pinnedIndexForTest,
  pinnedSocketForTest
} from '../src/main/network/deviceBinding'

// macOS pins each download stream to its network with IP_BOUND_IF / IPV6_BOUND_IF (CLAUDE.md:
// required so the streams stay on their link while system-wide merging is on). These tests check
// the option really is set, read back through getsockopt, and that the kernel enforces it.

const darwin = process.platform === 'darwin'
const ifNameToIndex = darwin
  ? koffi.load('/usr/lib/libSystem.B.dylib').func('uint32_t if_nametoindex(const char *)')
  : null

function listen(): Promise<Server> {
  const server = createServer((socket) => socket.end('ok'))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Resolves with the first data, or rejects with the socket's error. */
function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('data', (data) => resolve(data.toString()))
    socket.once('error', reject)
  })
}

/** A non-loopback interface with an IPv4 address (Wi-Fi or Ethernet), if this machine has one. */
function physicalDevice(): string | undefined {
  return Object.entries(networkInterfaces()).find(([, addrs]) =>
    addrs?.some((a) => a.family === 'IPv4' && !a.internal)
  )?.[0]
}

test.describe('per-network socket pinning @smoke', () => {
  test.skip(!darwin, 'IP_BOUND_IF is macOS only')

  test('binding is supported on macOS', async () => {
    expect(await deviceBindingSupported()).toBe(true)
  })

  test('an IPv4 socket is pinned to the interface index (IP_BOUND_IF)', async () => {
    expect(await pinnedIndexForTest('lo0', 4)).toBe(ifNameToIndex!('lo0'))
  })

  test('an IPv6 socket is pinned to the interface index (IPV6_BOUND_IF)', async () => {
    expect(await pinnedIndexForTest('lo0', 6)).toBe(ifNameToIndex!('lo0'))
  })

  test('an interface that does not exist cannot be pinned', async () => {
    await expect(pinnedIndexForTest('nosuch9', 4)).rejects.toThrow(
      /Couldn't bind a socket to nosuch9/
    )
  })

  test('a socket pinned to lo0 reaches a loopback server', async () => {
    const server = await listen()
    try {
      const socket = await pinnedSocketForTest('lo0', 4)
      socket.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
      expect(await outcome(socket)).toBe('ok')
      socket.destroy()
    } finally {
      server.close()
    }
  })

  test('the kernel keeps a pinned socket on its interface', async () => {
    const device = physicalDevice()
    test.skip(!device, 'no non-loopback IPv4 interface on this machine')
    const server = await listen()
    try {
      // Pinned to Wi-Fi/Ethernet, a loopback address is unreachable: the pin is enforced.
      const socket = await pinnedSocketForTest(device!, 4)
      socket.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port })
      await expect(outcome(socket)).rejects.toThrow()
      socket.destroy()
    } finally {
      server.close()
    }
  })

  test('connectRoute surfaces a vanished interface as a connect error', async () => {
    await deviceBindingSupported()
    const socket = connectRoute(
      { device: 'nosuch9', localAddress: '192.0.2.2', remoteAddress: '192.0.2.1', family: 4 },
      80
    )
    await expect(outcome(socket)).rejects.toThrow(/Couldn't bind a socket to nosuch9/)
  })

  test('connectFrom surfaces a vanished interface as a connect error', async () => {
    await deviceBindingSupported()
    const socket = connectFrom('192.0.2.2', '192.0.2.1', 80, 'nosuch9')
    await expect(outcome(socket)).rejects.toThrow(/Couldn't bind a socket to nosuch9/)
  })

  test('connectFrom without a known interface falls back to the source address', async () => {
    await deviceBindingSupported()
    // 192.0.2.2 belongs to no interface here, so there is nothing to pin to: binding the address
    // fails the same way a plain connect would.
    const socket = connectFrom('192.0.2.2', '192.0.2.1', 80)
    await expect(outcome(socket)).rejects.toThrow(/EADDRNOTAVAIL/)
  })

  test('loopback destinations connect without pinning', async () => {
    await deviceBindingSupported()
    const server = await listen()
    try {
      const { port } = server.address() as AddressInfo
      const viaRoute = connectRoute(
        { device: 'nosuch9', localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', family: 4 },
        port
      )
      expect(await outcome(viaRoute)).toBe('ok')
      viaRoute.destroy()
      const viaFrom = connectFrom(undefined, '127.0.0.1', port)
      expect(await outcome(viaFrom)).toBe('ok')
      viaFrom.destroy()
    } finally {
      server.close()
    }
  })
})

test.describe('pinned connections to this Mac over a physical interface @smoke', () => {
  test.skip(!darwin, 'IP_BOUND_IF is macOS only')

  /** A non-loopback interface and its IPv4 address. */
  function physical(): { device: string; address: string } | undefined {
    for (const [device, addrs] of Object.entries(networkInterfaces())) {
      const v4 = addrs?.find((a) => a.family === 'IPv4' && !a.internal)
      if (v4) return { device, address: v4.address }
    }
    return undefined
  }

  test('connectRoute and connectFrom reach the interface’s own address while pinned to it', async () => {
    const nic = physical()
    test.skip(!nic, 'no non-loopback IPv4 interface on this machine')
    await deviceBindingSupported()
    const server = createServer((socket) => socket.end('ok'))
    await new Promise<void>((resolve) => server.listen(0, nic!.address, resolve))
    try {
      const { port } = server.address() as AddressInfo
      const route = connectRoute(
        { device: nic!.device, localAddress: nic!.address, remoteAddress: nic!.address, family: 4 },
        port
      )
      expect(await outcome(route)).toBe('ok')
      route.destroy()
      // No device given: connectFrom finds the interface that owns the local address.
      const from = connectFrom(nic!.address, nic!.address, port)
      expect(await outcome(from)).toBe('ok')
      from.destroy()
    } finally {
      server.close()
    }
  })
})
