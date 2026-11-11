import { describe, expect, it } from 'vitest'
import { routeFor, sanitizeRouting } from './routing'
import { DEFAULT_ROUTING } from './types'

const connected =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe('routeFor', () => {
  it('all networks: each transfer uses its own, in either direction', () => {
    expect(routeFor(DEFAULT_ROUTING, 'down', connected('en0'))).toBeNull()
    expect(routeFor(DEFAULT_ROUTING, 'up', connected('en0'))).toBeNull()
  })

  it('a connected pin is the only network, each direction its own', () => {
    const routing = { down: 'en5', up: 'en0', fallback: true }
    expect([...routeFor(routing, 'down', connected('en0', 'en5'))!]).toEqual(['en5'])
    expect([...routeFor(routing, 'up', connected('en0', 'en5'))!]).toEqual(['en0'])
  })

  it('a pin that is gone: fallback hands back to each transfer, else nothing carries it', () => {
    expect(routeFor({ down: 'all', up: 'en5', fallback: true }, 'up', connected('en0'))).toBeNull()
    expect([...routeFor({ down: 'all', up: 'en5', fallback: false }, 'up', connected())!]).toEqual(
      []
    )
  })
})

describe('sanitizeRouting', () => {
  it('keeps what is right and defaults the rest', () => {
    expect(sanitizeRouting({ down: 'en5', up: 'en0', fallback: false })).toEqual({
      down: 'en5',
      up: 'en0',
      fallback: false
    })
    // Saved before uploads could be routed: they follow downloads.
    expect(sanitizeRouting({ down: 'en5', fallback: true })).toEqual({
      down: 'en5',
      up: 'all',
      fallback: true
    })
    expect(sanitizeRouting({ down: '', up: 'x'.repeat(65), fallback: 'no' })).toEqual(
      DEFAULT_ROUTING
    )
  })

  it('is nothing for what is not a record', () => {
    for (const value of [undefined, null, 'all', 3, ['en0']]) {
      expect(sanitizeRouting(value)).toBeUndefined()
    }
  })
})
