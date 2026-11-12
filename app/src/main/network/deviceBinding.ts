import { connect, Socket, type SocketConstructorOpts } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkRoute } from './routes'

// Each download stream must leave through the network it belongs to. Binding a socket to an
// interface's IP (Node's `localAddress`) is not enough on macOS once Mergelane's system-wide merge
// is on: its utun's 0/1 and 128/1 routes would capture the connection and the daemon would
// rebalance it. So the socket is pinned to the interface itself before it connects, with
// setsockopt IP_BOUND_IF / IPV6_BOUND_IF and the interface index. Node has no setsockopt, so the
// socket is made through libc (koffi) and handed to Node as an fd, as upstream Plexo did on Linux
// with SO_BINDTODEVICE (that Linux path is gone).
//
// Windows needs none of this (ADR-0055). It sends a packet out of the interface that owns the socket's
// source address (the strong host model, Windows' default since Vista: MIB_IPINTERFACE_ROW on Microsoft
// Learn), so connecting from the network's own address (localAddress, below) already pins the socket.

interface Constants {
  AF_INET: number
  AF_INET6: number
  SOCK_STREAM: number
  /** OR'd into the socket type where the platform has it; macOS has none and uses fcntl. */
  SOCK_CLOEXEC: number
}

// macOS SDK headers: sys/socket.h, netinet/in.h, netinet6/in6.h, sys/fcntl.h.
const DARWIN = {
  AF_INET: 2,
  AF_INET6: 30,
  SOCK_STREAM: 1,
  SOCK_CLOEXEC: 0,
  IPPROTO_IP: 0,
  IPPROTO_IPV6: 41,
  IP_BOUND_IF: 25,
  IPV6_BOUND_IF: 125,
  F_SETFD: 2,
  FD_CLOEXEC: 1
} as const

interface Libc {
  constants: Constants
  socket: (domain: number, type: number, protocol: number) => number
  /** Pins fd to the interface; 0 on success, -1 with errno set on failure. */
  bind: (fd: number, device: string, family: 4 | 6) => number
  /** Marks fd close-on-exec, since macOS's socket() can't; 0 on success. */
  cloexec: (fd: number) => number
  close: (fd: number) => number
  errno: () => number
  /** The interface index fd is pinned to, or 0 (used by tests). */
  boundIndex: (fd: number, family: 4 | 6) => number
}

/** Set once the support check below passes; until then everything falls back to localAddress. */
let libc: Libc | null = null
let support: Promise<boolean> | null = null

async function loadLibc(): Promise<Libc> {
  const { default: koffi } = await import('koffi')
  const lib = koffi.load('/usr/lib/libSystem.B.dylib')
  const setsockopt = lib.func('int setsockopt(int, int, int, const void *, uint32_t)')
  const getsockopt = lib.func('int getsockopt(int, int, int, _Out_ void *, _Inout_ uint32_t *)')
  const ifNameToIndex = lib.func('uint32_t if_nametoindex(const char *)')
  const fcntl = lib.func('int fcntl(int, int, ...)')
  const level = (family: 4 | 6): [number, number] =>
    family === 6
      ? [DARWIN.IPPROTO_IPV6, DARWIN.IPV6_BOUND_IF]
      : [DARWIN.IPPROTO_IP, DARWIN.IP_BOUND_IF]
  return {
    constants: DARWIN,
    socket: lib.func('int socket(int, int, int)'),
    bind: (fd, device, family) => {
      const index = ifNameToIndex(device) as number
      if (!index) return -1
      const value = Buffer.alloc(4)
      value.writeUInt32LE(index)
      return setsockopt(fd, ...level(family), value, 4) as number
    },
    cloexec: (fd) => fcntl(fd, DARWIN.F_SETFD, 'int', DARWIN.FD_CLOEXEC) as number,
    close: lib.func('int close(int)'),
    errno: () => koffi.errno(),
    boundIndex: (fd, family) => {
      const out = Buffer.alloc(4)
      const length = [4]
      if (getsockopt(fd, ...level(family), out, length) !== 0) return 0
      return out.readUInt32LE()
    }
  }
}

function openOnDevice(lib: Libc, device: string, family: 4 | 6): number {
  const { AF_INET, AF_INET6, SOCK_STREAM, SOCK_CLOEXEC } = lib.constants
  const fd = lib.socket(family === 6 ? AF_INET6 : AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0)
  if (fd < 0) throw new Error(`socket() failed (errno ${lib.errno()})`)
  if (lib.cloexec(fd) !== 0 || lib.bind(fd, device, family) !== 0) {
    const errno = lib.errno()
    lib.close(fd)
    throw new Error(`Couldn't bind a socket to ${device} (errno ${errno})`)
  }
  return fd
}

/** Whether each network can carry its own connections. */
export function deviceBindingSupported(
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  // Windows: the source address pins the socket (see the top of this file); nothing to load.
  if (platform === 'win32') return Promise.resolve(true)
  support ??= (async () => {
    try {
      const candidate = await loadLibc()
      // Loopback always exists, so this only fails when the system refuses.
      candidate.close(openOnDevice(candidate, 'lo0', 4))
      libc = candidate
      return true
    } catch (error) {
      console.warn('Per-network binding unavailable, using the default route:', error)
      return false
    }
  })()
  return support
}

/** For tests: opens a socket pinned to `device` and reports the interface index the system says it
 * is pinned to (macOS), then closes it. Throws when the socket can't be pinned. */
export async function pinnedIndexForTest(device: string, family: 4 | 6): Promise<number> {
  if (!(await deviceBindingSupported()) || !libc) throw new Error('binding unsupported')
  const fd = openOnDevice(libc, device, family)
  try {
    return libc.boundIndex(fd, family)
  } finally {
    libc.close(fd)
  }
}

/** For tests: a socket pinned to `device`, not yet connected. */
export async function pinnedSocketForTest(device: string, family: 4 | 6): Promise<Socket> {
  if (!(await deviceBindingSupported()) || !libc) throw new Error('binding unsupported')
  return new Socket({
    fd: openOnDevice(libc, device, family),
    manualStart: true
  } as SocketConstructorOpts)
}

/** A TCP connection through the already chosen device, to a numeric remote address. */
export function connectRoute(route: NetworkRoute, port: number): Socket {
  const { device, localAddress, remoteAddress, family } = route
  const loopback = remoteAddress === '::1' || remoteAddress.startsWith('127.')
  if (!libc || loopback) {
    return connect({ host: remoteAddress, port, localAddress, family })
  }

  let fd: number
  try {
    fd = openOnDevice(libc, device, family)
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const socket = new Socket()
    process.nextTick(() => socket.destroy(error as Error))
    return socket
  }
  // manualStart: a socket wrapped around an fd starts reading at once, before it's connected.
  // Bind both the device and source address: an interface may have several IPv6 addresses.
  return new Socket({ fd, manualStart: true } as SocketConstructorOpts).connect({
    host: remoteAddress,
    port,
    localAddress,
    family
  })
}

function deviceFor(localAddress: string, host: string): string | undefined {
  if (host === 'localhost' || host.startsWith('127.') || host === '::1') return undefined
  for (const [device, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some((addr) => addr.address === localAddress)) return device
  }
  return undefined
}

/** A TCP connection to host:port that leaves through the interface owning `localAddress` or `device`. */
export function connectFrom(
  localAddress: string | undefined,
  host: string,
  port: number,
  deviceName?: string
): Socket {
  const isLoopback = host === 'localhost' || host.startsWith('127.') || host === '::1'
  if (isLoopback) {
    return connect({ host, port })
  }

  const device = deviceName ?? (libc && localAddress ? deviceFor(localAddress, host) : undefined)
  if (!libc || !device) {
    return connect({ host, port, localAddress: localAddress || undefined })
  }

  const isIpv6 = Boolean(localAddress?.includes(':') || host.includes(':'))
  const family = isIpv6 ? 6 : 4
  let fd: number
  try {
    fd = openOnDevice(libc, device, family)
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const socket = new Socket()
    process.nextTick(() => socket.destroy(error as Error))
    return socket
  }
  return new Socket({ fd, manualStart: true } as SocketConstructorOpts).connect({
    host,
    port,
    localAddress: localAddress || undefined,
    family
  })
}
