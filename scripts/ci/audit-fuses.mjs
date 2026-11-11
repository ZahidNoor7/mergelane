// Audits the packaged app's Electron fuses with REA (https://github.com/morluto/rea), which reads
// the fuse bytes from the Electron Framework binary without launching the app, and fails when any
// fuse differs from what electron-builder.yml asks for.
//
// usage: node scripts/ci/audit-fuses.mjs <Mergelane.app> [rea-evidence.json]
// With a second argument, reads that saved REA evidence instead of running REA.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** REA's package, pinned so the audit can't change under us. */
export const REA = 'rea-agents@6.8.0'

/** What app/electron-builder.yml's electronFuses sets, by REA's fuse names. */
export const EXPECTED_FUSES = {
  RunAsNode: 'disabled',
  EnableCookieEncryption: 'enabled',
  EnableNodeOptionsEnvironmentVariable: 'disabled',
  EnableNodeCliInspectArguments: 'disabled',
  EnableEmbeddedAsarIntegrityValidation: 'enabled',
  OnlyLoadAppFromAsar: 'enabled'
}

/** Returns a list of problems; empty means every expected fuse has the expected state. */
export function checkFuses(evidence, expected = EXPECTED_FUSES) {
  const slices = evidence?.normalized_result?.slices
  if (!Array.isArray(slices) || slices.length === 0) {
    return ['REA evidence has no Mach-O slices: the fuse state is unknown']
  }
  const problems = []
  for (const slice of slices) {
    const sentinels = slice.sentinels ?? []
    if (sentinels.length !== 1) {
      problems.push(`slice ${slice.architecture}: expected 1 fuse sentinel, found ${sentinels.length}`)
      continue
    }
    const [sentinel] = sentinels
    if (sentinel.complete !== true) {
      problems.push(`slice ${slice.architecture}: fuse wire is incomplete`)
    }
    const states = new Map((sentinel.fuses ?? []).map((fuse) => [fuse.name, fuse.state]))
    for (const [name, want] of Object.entries(expected)) {
      const got = states.get(name)
      if (got !== want) {
        problems.push(`slice ${slice.architecture}: ${name} is ${got ?? 'missing'}, expected ${want}`)
      }
    }
  }
  return problems
}

/** Runs REA on the app and returns its evidence. `exec` is replaceable for tests. */
export function runRea(appPath, exec = execFileSync) {
  const out = exec(
    'npx',
    ['-y', REA, 'inspect-electron-fuses', appPath, '--format', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }
  )
  return JSON.parse(out)
}

export function main(argv, exec = execFileSync) {
  const [appPath, savedEvidence] = argv
  if (!appPath) {
    console.error('usage: node scripts/ci/audit-fuses.mjs <Mergelane.app> [rea-evidence.json]')
    return 2
  }
  const evidence = savedEvidence
    ? JSON.parse(readFileSync(savedEvidence, 'utf8'))
    : runRea(appPath, exec)
  const problems = checkFuses(evidence)
  for (const slice of evidence?.normalized_result?.slices ?? []) {
    for (const fuse of slice.sentinels?.[0]?.fuses ?? []) {
      console.log(`${slice.architecture}  ${fuse.name.padEnd(40)} ${fuse.state}`)
    }
  }
  if (problems.length) {
    for (const problem of problems) console.error(`audit-fuses: FAIL: ${problem}`)
    return 1
  }
  console.log('audit-fuses: PASS')
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2))
}
