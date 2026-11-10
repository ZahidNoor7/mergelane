import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, PROJECT_ROOT, test } from './fixtures'

// Phase 1 acceptance criteria 2 and 6 (app part), on the simulated network: CI only, inside
// scripts/netsim/with-netsim.sh with link 1 (feth10, 20 Mbit/s) and link 2 (feth20, 50 Mbit/s).
// The app's streams are pinned to each link with IP_BOUND_IF (deviceBinding.ts).
const SERVER = process.env.NETSIM_SERVER
const NETSIM = join(PROJECT_ROOT, '..', 'scripts', 'netsim', 'netsim.sh')
const MIB = 1024 * 1024

/** SHA-256 of the netsim server's /file/<MiB>: byte i is i % 251. */
function netsimSha(mib: number): string {
  const hash = createHash('sha256')
  const block = Buffer.alloc(MIB)
  for (let offset = 0; offset < mib * MIB; offset += MIB) {
    for (let i = 0; i < MIB; i++) block[i] = (offset + i) % 251
    hash.update(block)
  }
  return hash.digest('hex')
}

test.describe('downloads over two simulated links @netsim', () => {
  test.skip(!SERVER, 'needs the simulated network (scripts/netsim/with-netsim.sh)')
  test.use({
    appEnv: {
      MERGELANE_E2E_INTERFACES: 'feth10=10.77.1.2,feth20=10.77.2.2',
      MERGELANE_E2E_BLOCK_BYTES: String(MIB),
      MERGELANE_E2E_STALL_MS: '3000'
    }
  })

  test('criterion 2: one file uses both links and beats the faster link alone', async ({
    mergelane
  }) => {
    test.setTimeout(240_000)
    const mib = 48
    const sha = netsimSha(mib)

    const t0 = Date.now()
    await mergelane.start(`http://${SERVER}/file/${mib}`, sha, {
      networks: ['feth20'],
      connections: 6
    })
    await mergelane.waitForHttpStatus('completed', 120_000)
    const fastAlone = (mib * MIB * 8) / ((Date.now() - t0) / 1000) / 1e6

    const t1 = Date.now()
    await mergelane.start(`http://${SERVER}/file/${mib}?both`, sha, {
      networks: ['feth10', 'feth20'],
      connections: 6
    })
    const done = await mergelane.waitForHttpStatus('completed', 120_000)
    const both = (mib * MIB * 8) / ((Date.now() - t1) / 1000) / 1e6
    const byLink = Object.fromEntries(done.networks.map((n) => [n.id, n.bytesDownloaded]))
    console.log(
      `fast link alone ${fastAlone.toFixed(1)} Mbit/s, both ${both.toFixed(1)} Mbit/s, bytes by link ${JSON.stringify(byLink)}`
    )
    for (const id of ['feth10', 'feth20']) {
      expect(byLink[id] ?? 0, `${id} carried part of the file`).toBeGreaterThan(0.15 * mib * MIB)
    }
    expect(both, 'both links beat the faster link alone').toBeGreaterThan(fastAlone * 1.1)
  })

  test('criterion 6: a link dying mid-download, the download completes over the other', async ({
    mergelane
  }) => {
    test.setTimeout(240_000)
    const mib = 48
    await mergelane.start(`http://${SERVER}/file/${mib}`, netsimSha(mib), {
      networks: ['feth10', 'feth20'],
      connections: 6
    })
    await mergelane.waitUntil((state) => state.bytesDownloaded > 4 * MIB, 60_000)
    execFileSync('sudo', ['bash', NETSIM, 'drop', '2', 'loss'], { stdio: 'inherit' })
    try {
      const done = await mergelane.waitForHttpStatus('completed', 180_000)
      expect(done.bytesDownloaded).toBe(mib * MIB)
    } finally {
      execFileSync('sudo', ['bash', NETSIM, 'restore', '2'], { stdio: 'inherit' })
    }
  })
})
