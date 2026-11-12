import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserPipePath } from './browserPipe'

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'shared', 'fixtures', 'browser-pipe.json'), 'utf8')
) as { cases: { userData: string; pipe: string }[] }

describe('browserPipePath', () => {
  it('names the same pipe as the helper and the test kit', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3)
    for (const { userData, pipe } of fixture.cases)
      expect(browserPipePath(userData), userData).toBe(pipe)
  })

  it('is one pipe per folder, whatever its case', () => {
    expect(browserPipePath('C:\\Users\\A\\x')).toBe(browserPipePath('c:\\users\\a\\x'))
    expect(browserPipePath('C:\\Users\\A\\x')).not.toBe(browserPipePath('C:\\Users\\A\\y'))
    expect(browserPipePath('C:\\x')).toMatch(/^\\\\\.\\pipe\\mergelane-browser-[0-9a-f]{16}$/)
  })
})
