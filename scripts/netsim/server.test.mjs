// Tests for the netsim test server's request handling. Run: node --test scripts/netsim/server.test.mjs
// main() normally binds 10.77.99.1, which exists only while netsim is up (root); these tests bind
// 127.0.0.1 instead, and the CI netsim job runs it for real.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { createCounters, fillBlock, handleControl, handleFile, main, parseRange } from './server.mjs'

const MIB = 1024 * 1024

function serve(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function get(server, path, { method = 'GET', headers = {} } = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('parseRange handles explicit, open-ended, suffix and bad ranges', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=50-1000', 100), { start: 50, end: 99 })
  for (const bad of [undefined, '', 'bytes=-', 'bytes=-0', 'bytes=100-', 'bytes=9-3', 'items=0-1', 'bytes=0-1,4-5']) {
    assert.equal(parseRange(bad, 100), null, String(bad))
  }
})

test('fillBlock produces position-dependent bytes', () => {
  assert.deepEqual([...fillBlock(Buffer.alloc(4), 249)], [249, 250, 0, 1])
})

test('counters count requests, distinct clients and bytes, and reset', () => {
  const c = createCounters(['1', '2'])
  c.request('1', '10.77.1.2')
  c.request('1', '10.77.1.2')
  c.request('2', '10.77.2.2')
  c.bytes('1', 100)
  assert.deepEqual(c.links['1'], { bytes: 100, requests: 2, clients: ['10.77.1.2'] })
  c.reset()
  assert.deepEqual(c.links['1'], { bytes: 0, requests: 0, clients: [] })
})

test('a ranged GET returns 206 with the right bytes, headers and counters', async (t) => {
  const counters = createCounters(['1'])
  const server = await serve((req, res) => handleFile(req, res, { id: '1', counters, ranges: true }))
  t.after(() => server.close())
  const res = await get(server, '/file/1', { headers: { range: 'bytes=300000-300009' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], `bytes 300000-300009/${MIB}`)
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(res.headers.etag, `"netsim-${MIB}"`)
  assert.deepEqual([...res.body], [...fillBlock(Buffer.alloc(10), 300000)])
  assert.equal(counters.links['1'].bytes, 10)
  assert.equal(counters.links['1'].requests, 1)
})

test('a whole-file GET streams every byte across blocks', async (t) => {
  const counters = createCounters(['1'])
  const server = await serve((req, res) => handleFile(req, res, { id: '1', counters, ranges: true }))
  t.after(() => server.close())
  const res = await get(server, '/file/1')
  assert.equal(res.status, 200)
  assert.equal(res.body.length, MIB)
  assert.ok(res.body.equals(fillBlock(Buffer.alloc(MIB), 0)))
  assert.equal(counters.links['1'].bytes, MIB)
})

test('HEAD, 416, /norange, /whoami and 404', async (t) => {
  const counters = createCounters(['2'])
  const server = await serve((req, res) => handleFile(req, res, { id: '2', counters, ranges: true }))
  t.after(() => server.close())
  const head = await get(server, '/file/2', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(2 * MIB))
  assert.equal(head.body.length, 0)
  const unsatisfiable = await get(server, '/file/1', { headers: { range: `bytes=${MIB}-` } })
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers['content-range'], `bytes */${MIB}`)
  const norange = await get(server, '/norange/1', { headers: { range: 'bytes=0-9' } })
  assert.equal(norange.status, 200)
  assert.equal(norange.headers['accept-ranges'], undefined)
  assert.equal(norange.body.length, MIB)
  const who = await get(server, '/whoami')
  assert.deepEqual(JSON.parse(who.body.toString()), { client: '127.0.0.1', link: '2' })
  assert.equal((await get(server, '/nope')).status, 404)
})

test('a server built without ranges ignores Range', async (t) => {
  const counters = createCounters(['1'])
  const server = await serve((req, res) => handleFile(req, res, { id: '1', counters, ranges: false }))
  t.after(() => server.close())
  const res = await get(server, '/file/1', { headers: { range: 'bytes=0-9' } })
  assert.equal(res.status, 200)
  assert.equal(res.body.length, MIB)
})

test('control: stats, reset and 404', async (t) => {
  const counters = createCounters(['1'])
  counters.bytes('1', 5)
  const server = await serve((req, res) => handleControl(req, res, counters))
  t.after(() => server.close())
  const stats = JSON.parse((await get(server, '/stats')).body.toString())
  assert.equal(stats.links['1'].bytes, 5)
  assert.equal((await get(server, '/reset', { method: 'POST' })).status, 200)
  assert.equal(counters.links['1'].bytes, 0)
  assert.equal((await get(server, '/other')).status, 404)
})

test('main starts one listener per link plus control, and rejects bad ids', async () => {
  const started = await main(['7', '0'], '127.0.0.1')
  try {
    const [file, control] = started.servers
    assert.equal(file.address().port, 8087)
    const res = await get(file, '/whoami')
    assert.equal(JSON.parse(res.body.toString()).link, '7')
    const stats = JSON.parse((await get(control, '/stats')).body.toString())
    assert.equal(stats.links['7'].requests, 1)
  } finally {
    for (const server of started.servers) server.close()
  }
  const errors = []
  const { error } = console
  console.error = (...args) => errors.push(args.join(' '))
  try {
    assert.equal(await main(['9']), null)
    assert.equal(await main([]), null)
  } finally {
    console.error = error
    process.exitCode = 0
  }
  assert.match(errors[0], /^usage:/)
})

test('with an IPv6 address, each link also listens there and counts into the same link', async () => {
  // netsim's own IPv6 address exists only while it is up; ::1 stands in for it here.
  const started = await main(['6', '0', '::1'], '127.0.0.1')
  try {
    const [v4, v6, control] = started.servers
    assert.equal(v4.address().port, 8086)
    assert.deepEqual([v6.address().address, v6.address().port], ['::1', 8086])
    const who = await new Promise((resolve, reject) => {
      const req = request({ host: '::1', family: 6, port: 8086, path: '/whoami' }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())))
      })
      req.on('error', reject)
      req.end()
    })
    assert.deepEqual(who, { client: '::1', link: '6' })
    await get(v4, '/whoami')
    const stats = JSON.parse((await get(control, '/stats')).body.toString())
    assert.equal(stats.links['6'].requests, 2)
    assert.deepEqual(stats.links['6'].clients, ['::1', '127.0.0.1'])
  } finally {
    for (const server of started.servers) server.close()
  }
})

test('main rejects an IPv6 argument that is not an address', async () => {
  const { error } = console
  console.error = () => {}
  try {
    assert.equal(await main(['1', '0', 'localhost'], '127.0.0.1'), null)
  } finally {
    console.error = error
    process.exitCode = 0
  }
})
