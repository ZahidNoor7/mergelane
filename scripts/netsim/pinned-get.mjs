// Downloads over one interface, pinned with IP_BOUND_IF (IPV6_BOUND_IF for an IPv6 host) through
// koffi (the same mechanism the app's downloader uses), and prints bytes and Mbit/s as JSON. Used by
// the netsim self-test.
//
// usage: node pinned-get.mjs <iface> <host> <port> <path> [seconds]
import { createRequire } from 'node:module'
import { isIPv6, Socket } from 'node:net'

// koffi is the app's dependency; load it from app/node_modules.
const koffi = createRequire(new URL('../../app/package.json', import.meta.url))('koffi')

// macOS SDK: sys/socket.h, netinet/in.h, netinet6/in6.h, sys/fcntl.h.
const AF_INET = 2
const AF_INET6 = 30
const SOCK_STREAM = 1
const IPPROTO_IP = 0
const IPPROTO_IPV6 = 41
const IP_BOUND_IF = 25
const IPV6_BOUND_IF = 125
const F_SETFD = 2
const FD_CLOEXEC = 1

const lib = koffi.load('/usr/lib/libSystem.B.dylib')
const socket = lib.func('int socket(int, int, int)')
const setsockopt = lib.func('int setsockopt(int, int, int, const void *, uint32_t)')
const fcntl = lib.func('int fcntl(int, int, ...)')
const closeFd = lib.func('int close(int)')
const ifNameToIndex = lib.func('uint32_t if_nametoindex(const char *)')

const [iface, host, port, path, seconds = '5'] = process.argv.slice(2)
const v6 = isIPv6(host)
const index = ifNameToIndex(iface)
if (!index) throw new Error(`no interface ${iface}`)
const fd = socket(v6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0)
if (fd < 0) throw new Error(`socket() errno ${koffi.errno()}`)
fcntl(fd, F_SETFD, 'int', FD_CLOEXEC)
const value = Buffer.alloc(4)
value.writeUInt32LE(index)
const [level, option, name] = v6 ? [IPPROTO_IPV6, IPV6_BOUND_IF, 'IPV6_BOUND_IF'] : [IPPROTO_IP, IP_BOUND_IF, 'IP_BOUND_IF']
if (setsockopt(fd, level, option, value, 4) !== 0) {
  const errno = koffi.errno()
  closeFd(fd)
  throw new Error(`${name} errno ${errno}`)
}
const s = new Socket({ fd, manualStart: true })
let bytes = 0
let header = true
const t0 = Date.now()
let finished = false
const done = (why) => {
  if (finished) return // the transfer can end before the timer fires: report once
  finished = true
  const secs = (Date.now() - t0) / 1000
  s.destroy()
  console.log(JSON.stringify({ iface, bytes, secs, mbit: (bytes * 8) / 1e6 / secs, why }))
}
s.setTimeout(10_000, () => done('timeout'))
s.on('error', (e) => done(`error ${e.code ?? e.message}`))
s.on('end', () => done('end'))
s.connect({ host, port: Number(port) }, () => {
  s.write(`GET ${path} HTTP/1.1\r\nHost: ${v6 ? `[${host}]` : host}\r\nConnection: close\r\n\r\n`)
  setTimeout(() => done('time'), Number(seconds) * 1000)
})
s.on('data', (chunk) => {
  if (header) {
    const i = chunk.indexOf('\r\n\r\n')
    if (i < 0) return
    header = false
    chunk = chunk.subarray(i + 4)
  }
  bytes += chunk.length
})
