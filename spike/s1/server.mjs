// Spike S1 test server: serves a deterministic file with Range support and logs which source
// address each request came from. usage: node server.mjs <host> <port> [sizeMiB]
import { createServer } from 'node:http'

const [host = '10.77.99.1', port = '8081', sizeMiB = '256'] = process.argv.slice(2)
const size = Number(sizeMiB) * 1024 * 1024
const block = Buffer.alloc(1024 * 1024)
for (let i = 0; i < block.length; i++) block[i] = i % 251

const server = createServer((req, res) => {
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
  if (req.url === '/whoami') {
    res.end(JSON.stringify({ peer, local: `${req.socket.localAddress}:${req.socket.localPort}` }))
    return
  }
  let start = 0
  let end = size - 1
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    start = Number(range[1])
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', '"spike-s1"')
  res.setHeader('Content-Length', String(end - start + 1))
  console.log(`${port} ${peer} ${req.method} ${req.url} ${start}-${end}`)
  let pos = start
  const pump = () => {
    while (pos <= end) {
      const off = pos % block.length
      const n = Math.min(block.length - off, end - pos + 1)
      pos += n
      if (!res.write(block.subarray(off, off + n))) return res.once('drain', pump)
    }
    res.end()
  }
  pump()
})
server.listen(Number(port), host, () => console.log(`listening ${host}:${port}`))
