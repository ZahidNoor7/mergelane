// Test server for the simulated network (scripts/netsim/netsim.sh). One HTTP listener per link on
// 10.77.99.1:808N; pf redirects 198.51.100.10:80 arriving over link N there, so the port says which
// link a request came through. A control listener on 127.0.0.1 reports per-link counters.
//
// usage: node server.mjs <link ids, e.g. 1,2> [control port, default 8090]
//
// Paths on 198.51.100.10:
//   /file/<MiB>         deterministic content with Range support and a strong ETag
//   /norange/<MiB>      the same bytes, but ignores Range (always 200, no Accept-Ranges)
//   /whoami             the client address and link, as JSON
// Control on 127.0.0.1:<control port>:
//   GET /stats          {"links":{"1":{"bytes":…,"requests":…,"clients":[…]},…}}
//   POST /reset         zeroes the counters
import { createServer } from 'node:http'

const MIB = 1024 * 1024
const LOCAL_SERVER_IP = '10.77.99.1'

/** Byte i of every file is i % 251, so any range can be generated and checked without storage. */
export function fillBlock(buf, offset) {
  for (let i = 0; i < buf.length; i++) buf[i] = (offset + i) % 251
  return buf
}

/** Parses a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range. Null when absent or unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start
  let end
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return null
  return { start, end }
}

export function createCounters(ids) {
  const links = Object.fromEntries(ids.map((id) => [id, { bytes: 0, requests: 0, clients: [] }]))
  return {
    links,
    request(id, client) {
      const link = links[id]
      link.requests++
      if (!link.clients.includes(client)) link.clients.push(client)
    },
    bytes(id, n) {
      links[id].bytes += n
    },
    reset() {
      for (const link of Object.values(links)) Object.assign(link, { bytes: 0, requests: 0, clients: [] })
    }
  }
}

export function handleFile(req, res, { id, counters, ranges }) {
  const url = new URL(req.url, 'http://x')
  const client = req.socket.remoteAddress
  counters.request(id, client)
  if (url.pathname === '/whoami') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ client, link: id }))
    return
  }
  const m = /^\/(file|norange)\/(\d+)$/.exec(url.pathname)
  if (!m) {
    res.statusCode = 404
    res.end()
    return
  }
  const size = Number(m[2]) * MIB
  const allowRanges = ranges && m[1] === 'file'
  let start = 0
  let end = size - 1
  const range = allowRanges ? parseRange(req.headers.range, size) : null
  if (allowRanges && req.headers.range && !range) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }
  if (range) {
    ;({ start, end } = range)
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  if (allowRanges) {
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('ETag', `"netsim-${size}"`)
  }
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', String(end - start + 1))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const block = Buffer.alloc(256 * 1024)
  let pos = start
  const pump = () => {
    while (pos <= end) {
      const n = Math.min(block.length, end - pos + 1)
      fillBlock(block.subarray(0, n), pos)
      pos += n
      counters.bytes(id, n)
      if (!res.write(block.subarray(0, n))) return res.once('drain', pump)
    }
    res.end()
  }
  pump()
}

export function handleControl(req, res, counters) {
  if (req.method === 'GET' && req.url === '/stats') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ links: counters.links }))
  } else if (req.method === 'POST' && req.url === '/reset') {
    counters.reset()
    res.end('{}')
  } else {
    res.statusCode = 404
    res.end()
  }
}

/** Starts one file listener per link (port 808N on host) and the control listener. */
export async function start(ids, controlPort, host = LOCAL_SERVER_IP) {
  const counters = createCounters(ids)
  const listen = (server, port, address) =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, address, () => resolve(server))
    })
  const servers = []
  for (const id of ids) {
    const server = createServer((req, res) => handleFile(req, res, { id, counters, ranges: true }))
    servers.push(await listen(server, 8080 + Number(id), host))
  }
  const control = createServer((req, res) => handleControl(req, res, counters))
  servers.push(await listen(control, controlPort, '127.0.0.1'))
  return { counters, servers, control }
}

export async function main(argv, host = LOCAL_SERVER_IP) {
  const ids = (argv[0] ?? '').split(',').filter(Boolean)
  const controlPort = Number(argv[1] ?? 8090)
  if (ids.length === 0 || ids.some((id) => !/^[1-8]$/.test(id))) {
    console.error('usage: node server.mjs <link ids, e.g. 1,2> [control port]')
    process.exitCode = 2
    return null
  }
  const started = await start(ids, controlPort, host)
  console.log(`netsim server: links ${ids.join(',')} on ${host}:808N, control 127.0.0.1:${started.control.address().port}`)
  return started
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2))
