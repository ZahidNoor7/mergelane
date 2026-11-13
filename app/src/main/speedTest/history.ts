import { pruneSpeedTests, sanitizeSpeedTests, type SpeedTestRun } from '../../shared/speedTest'
import { readJson, updateJson } from '../jsonFile'

// speed-tests.json in userData (docs/DECISIONS.md ADR-0064): the runs, newest first, at most
// SPEED_TESTS_KEPT and none older than 90 days. Free of Electron: the path is given.

export class SpeedTestHistory {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  async list(): Promise<SpeedTestRun[]> {
    return sanitizeSpeedTests(await readJson(this.path), this.now())
  }

  async add(run: SpeedTestRun): Promise<void> {
    await updateJson(this.path, (current) => ({
      version: 1,
      runs: pruneSpeedTests([run, ...sanitizeSpeedTests(current, this.now())], this.now())
    }))
  }

  async clear(): Promise<void> {
    await updateJson(this.path, () => ({ version: 1, runs: [] }))
  }
}
