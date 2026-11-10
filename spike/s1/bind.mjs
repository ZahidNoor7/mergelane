// Spike S1: pin a TCP socket to one interface with IP_BOUND_IF through koffi, the same way Plexo's
// deviceBinding.ts does SO_BINDTODEVICE on Linux, then download for a few seconds.
//
// usage: node bind.mjs <iface|-> <host> <port> <seconds> [iface2 ...]
// With several interfaces, downloads run on all of them at once and the total is reported.
import koffi from 'koffi'
import { Socket } from 'node:net'

// Values from the macOS SDK headers (sys/socket.h, netinet/in.h, netinet6/in6.h, sys/fcntl.h).
const AF_INET = 2
const SOCK_STREAM = 1
const IPPROTO_IP = 0
const IP_BOUND_IF = 25
const F_SETFD = 2
const FD_CLOEXEC = 1

const lib = koffi.load('/usr/lib/libSystem.B.dylib')
const c = {
  socket: lib.func('int socket(int, int, int)'),
  setsockopt: lib.func('int setsockopt(int, int, int, const void *, uint32_t)'),
  getsockopt: lib.func('int getsockopt(int, int, int, _Out_ void *, _Inout_ uint32_t *)'),
  close: lib.func('int close(int)'),
  fcntl: lib.func('int fcntl(int, int, ...)'),
  if_nametoindex: lib.func('uint32_t if_nametoindex(const char *)')
}

function pinnedSocket(iface) {
  const index = c.if_nametoindex(iface)
  if (!index) throw new Error(`if_nametoindex(${iface}) failed errno=${koffi.errno()}`)
  const fd = c.socket(AF_INET, SOCK_STREAM, 0)
  if (fd < 0) throw new Error(`socket failed errno=${koffi.errno()}`)
  if (c.fcntl(fd, F_SETFD, 'int', FD_CLOEXEC) !== 0) throw new Error(`fcntl errno=${koffi.errno()}`)
  const value = Buffer.alloc(4)
  value.writeUInt32LE(index)
  if (c.setsockopt(fd, IPPROTO_IP, IP_BOUND_IF, value, 4) !== 0) {
    const errno = koffi.errno()
    c.close(fd)
    throw new Error(`setsockopt(IP_BOUND_IF) errno=${errno}`)
  }
  const out = Buffer.alloc(4)
  const len = [4]
  c.getsockopt(fd, IPPROTO_IP, IP_BOUND_IF, out, len)
  console.log(`${iface}: index=${index} fd=${fd} readback=${out.readUInt32LE()} len=${len[0]}`)
  return new Socket({ fd, manualStart: true })
}

function download(iface, host, port, seconds) {
  return new Promise((resolve) => {
    const socket = iface === '-' ? new Socket() : pinnedSocket(iface)
    let bytes = 0
    let headerDone = false
    let t0 = Date.now()
    const finish = (why) => {
      const secs = (Date.now() - t0) / 1000
      socket.destroy()
      resolve({ iface, bytes, secs, mbit: (bytes * 8) / 1e6 / secs, why })
    }
    socket.setTimeout(10000, () => finish('timeout'))
    socket.on('error', (e) => finish(`error ${e.code ?? e.message}`))
    socket.connect({ host, port: Number(port) }, () => {
      console.log(`${iface}: connected local=${socket.localAddress}:${socket.localPort}`)
      t0 = Date.now()
      socket.write(`GET /big HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
      setTimeout(() => finish('done'), Number(seconds) * 1000)
    })
    socket.on('data', (chunk) => {
      if (!headerDone) {
        const i = chunk.indexOf('\r\n\r\n')
        if (i < 0) return
        console.log(`${iface}: ${chunk.subarray(0, chunk.indexOf('\r\n')).toString()}`)
        headerDone = true
        chunk = chunk.subarray(i + 4)
      }
      bytes += chunk.length
    })
  })
}

const [first, host, port, seconds, ...more] = process.argv.slice(2)
const results = await Promise.all([first, ...more].map((i) => download(i, host, port, seconds)))
let total = 0
for (const r of results) {
  total += r.mbit
  console.log(`RESULT ${r.iface} ${r.mbit.toFixed(1)} Mbit/s (${r.bytes} bytes in ${r.secs.toFixed(1)} s, ${r.why})`)
}
console.log(`RESULT total ${total.toFixed(1)} Mbit/s`)
