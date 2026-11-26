import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { saveCheckpoint, type JournalDisk } from './journal'

// A model of a drive that loses what wasn't flushed. The download writes its bytes in order, so the
// data is a count: `written` bytes are in the file, `durable` of them are on the drive. The chunk
// map is a count too: how many bytes it claims. A crash loses every unflushed byte and, if a rename
// wasn't flushed yet, may keep either the old map or the new one.

class Crash extends Error {}

/** Between two steps of a save: some bytes arrive, and maybe the power goes. */
interface Step {
  writes: number
  crash: boolean
}

class ModelDisk implements JournalDisk {
  written = 0
  durable = 0
  temporary?: number
  /** The map a reader sees now. */
  map?: number
  /** The map that is sure to survive a crash. */
  durableMap?: number
  renamePending = false
  private next = 0

  constructor(private readonly steps: readonly Step[]) {}

  /** The download keeps writing while a save runs; the script says how much, and when it crashes. */
  between(): void {
    const step = this.steps[this.next++ % Math.max(1, this.steps.length)] ?? {
      writes: 0,
      crash: false
    }
    this.written += step.writes
    if (step.crash && this.next <= this.steps.length) throw new Crash()
  }

  async flushData(): Promise<void> {
    // What a flush makes safe is what was written when it started; bytes that land during it may
    // not be.
    const target = this.written
    this.between()
    this.durable = Math.max(this.durable, target)
  }

  async writeTemporary(text: string): Promise<void> {
    this.between()
    this.temporary = Number(text)
  }

  async replace(): Promise<void> {
    this.between()
    this.map = this.temporary
    this.renamePending = true
  }

  async flushFolder(): Promise<void> {
    this.between()
    this.durableMap = this.map
    this.renamePending = false
  }

  /** The map a relaunch reads after a crash now. */
  survivingMap(keepNewer: boolean): number {
    if (this.renamePending && keepNewer) return this.map ?? 0
    return this.durableMap ?? 0
  }
}

type Save = (disk: JournalDisk, map: string, flushData: boolean) => Promise<void>

/** Runs checkpoints until the script crashes (or runs out), then returns what a relaunch finds. */
async function runUntilCrash(
  save: Save,
  steps: readonly Step[],
  checkpoints: number,
  keepNewer: boolean
): Promise<{ claimed: number; durable: number }> {
  const disk = new ModelDisk(steps)
  try {
    for (let i = 0; i < checkpoints; i++) {
      // The map is taken as the download stands, before the save flushes anything.
      const map = String(disk.written)
      await save(disk, map, true)
      disk.between()
    }
  } catch (error) {
    if (!(error instanceof Crash)) throw error
  }
  return { claimed: disk.survivingMap(keepNewer), durable: disk.durable }
}

// A crash at one step in ten, so runs often get through several saves before the power goes.
const stepsArb = fc.array(
  fc.record({
    writes: fc.nat({ max: 64 }),
    crash: fc.integer({ min: 0, max: 9 }).map((roll) => roll === 0)
  }),
  { minLength: 1, maxLength: 60 }
)

describe('the save order', () => {
  it('never leaves a map claiming bytes that a crash lost', async () => {
    await fc.assert(
      fc.asyncProperty(
        stepsArb,
        fc.integer({ min: 1, max: 8 }),
        fc.boolean(),
        async (steps, checkpoints, keepNewer) => {
          const { claimed, durable } = await runUntilCrash(
            saveCheckpoint,
            steps,
            checkpoints,
            keepNewer
          )
          expect(claimed).toBeLessThanOrEqual(durable)
        }
      ),
      { numRuns: 500 }
    )
  })

  it('is what catches a save that writes the map before flushing the data', async () => {
    // The same check against the wrong order fails, so the model is strict enough to matter. Eight
    // bytes arrive at every step; the power goes during the second save's data flush, after its
    // map is already on the drive.
    const mapFirst: Save = async (disk, map, flushData) => {
      await disk.writeTemporary(map)
      await disk.replace()
      await disk.flushFolder()
      if (flushData) await disk.flushData()
    }
    const steps: Step[] = [
      ...Array.from({ length: 8 }, () => ({ writes: 8, crash: false })),
      { writes: 8, crash: true }
    ]
    const wrong = await runUntilCrash(mapFirst, steps, 3, true)
    expect(wrong.claimed).toBeGreaterThan(wrong.durable)
    // The real order, through the same script, stays safe.
    const right = await runUntilCrash(saveCheckpoint, steps, 3, true)
    expect(right.claimed).toBeLessThanOrEqual(right.durable)
  })

  it('runs every step in order, flushing the data only when asked', async () => {
    const calls: string[] = []
    const disk: JournalDisk = {
      flushData: async () => void calls.push('data'),
      writeTemporary: async (text) => void calls.push(`write ${text}`),
      replace: async () => void calls.push('rename'),
      flushFolder: async () => void calls.push('folder')
    }
    await saveCheckpoint(disk, '{"a":1}', true)
    await saveCheckpoint(disk, '{"a":2}', false)
    expect(calls).toEqual([
      'data',
      'write {"a":1}',
      'rename',
      'folder',
      'write {"a":2}',
      'rename',
      'folder'
    ])
  })

  it('stops at the first step that fails', async () => {
    const calls: string[] = []
    const disk: JournalDisk = {
      flushData: async () => {
        calls.push('data')
        throw new Error('drive gone')
      },
      writeTemporary: async () => void calls.push('write'),
      replace: async () => void calls.push('rename'),
      flushFolder: async () => void calls.push('folder')
    }
    await expect(saveCheckpoint(disk, '{}', true)).rejects.toThrow('drive gone')
    expect(calls).toEqual(['data'])
  })
})
