import { describe, expect, it } from 'vitest'
import { byRole, networkStatuses, roleOf, sanitizeRole, type NetworkFacts } from './networkRoles'
import type { NetworkRole } from './types'

const net = (id: string, role: NetworkRole, facts: Partial<NetworkFacts> = {}): NetworkFacts => ({
  id,
  role,
  enabled: true,
  status: 'on',
  connected: true,
  atLimit: false,
  ...facts
})

describe('roleOf', () => {
  it('is use unless the preference says standby or never', () => {
    expect(roleOf(undefined)).toBe('use')
    expect(roleOf({})).toBe('use')
    expect(roleOf({ off: true })).toBe('use')
    expect(roleOf({ role: 'standby' })).toBe('standby')
    expect(roleOf({ role: 'never' })).toBe('never')
    // A hand-edited file: anything else is the default.
    expect(roleOf({ role: 'backup' as never })).toBe('use')
  })
})

describe('sanitizeRole', () => {
  it('keeps standby and never, drops use and anything else', () => {
    expect(sanitizeRole('standby')).toBe('standby')
    expect(sanitizeRole('never')).toBe('never')
    expect(sanitizeRole('use')).toBeUndefined()
    expect(sanitizeRole(undefined)).toBeUndefined()
    expect(sanitizeRole(1)).toBeUndefined()
    expect(sanitizeRole({ role: 'standby' })).toBeUndefined()
  })
})

describe('byRole', () => {
  it('puts Use first, then Standby, then Don’t use, keeping the given order within each', () => {
    const roles: Record<string, NetworkRole> = { a: 'standby', b: 'never', c: 'use', d: 'use' }
    const sorted = byRole(
      ['a', 'b', 'c', 'd'].map((id) => ({ id })),
      (network) => roles[network.id]
    )
    expect(sorted.map((each) => each.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('leaves an empty list empty and does not change the one given', () => {
    expect(byRole([], () => 'use')).toEqual([])
    const given = [{ id: 'x' }, { id: 'y' }]
    byRole(given, (network) => (network.id === 'x' ? 'standby' : 'use'))
    // Plain ids work too.
    expect(byRole(['x', 'y'], (id) => (id === 'x' ? 'standby' : 'use'))).toEqual(['y', 'x'])
    expect(given.map((each) => each.id)).toEqual(['x', 'y'])
  })
})

describe('networkStatuses', () => {
  it('all on Use: nothing changes', () => {
    expect(networkStatuses([net('a', 'use'), net('b', 'use')], null)).toEqual(['on', 'on'])
  })

  it('a Standby network waits while a Use network is connected', () => {
    expect(networkStatuses([net('a', 'use'), net('b', 'standby')], null)).toEqual(['on', 'standby'])
  })

  it('a Use network that is connected but not getting through yet still holds standby back', () => {
    expect(
      networkStatuses([net('a', 'use', { status: 'unreachable' }), net('b', 'standby')], null)
    ).toEqual(['unreachable', 'standby'])
  })

  it('standby takes over when the Use network drops, and waits again once it is back', () => {
    const dropped = networkStatuses(
      [net('a', 'use', { connected: false }), net('b', 'standby', { status: 'standby' })],
      null
    )
    expect(dropped).toEqual(['offline', 'on'])
    const back = networkStatuses(
      [net('a', 'use', { status: 'offline' }), net('b', 'standby', { status: 'on' })],
      null
    )
    expect(back).toEqual(['on', 'standby'])
  })

  it('standby takes over when the Use networks are off, at their limit or failed', () => {
    expect(
      networkStatuses(
        [
          net('a', 'use', { enabled: false }),
          net('b', 'use', { atLimit: true }),
          net('c', 'use', { status: 'failed' }),
          net('d', 'standby', { status: 'standby' })
        ],
        null
      )
    ).toEqual(['off', 'limit', 'failed', 'on'])
  })

  it('a download on standby networks only uses them', () => {
    expect(networkStatuses([net('b', 'standby'), net('c', 'standby')], null)).toEqual(['on', 'on'])
  })

  it('another Standby network does not hold one back', () => {
    expect(
      networkStatuses(
        [net('a', 'use', { connected: false }), net('b', 'standby'), net('c', 'standby')],
        null
      )
    ).toEqual(['offline', 'on', 'on'])
  })

  it('a held-back Standby network that had failed waits too, and is tried afresh when it takes over', () => {
    expect(
      networkStatuses([net('a', 'use'), net('b', 'standby', { status: 'failed' })], null)
    ).toEqual(['on', 'standby'])
    expect(
      networkStatuses(
        [net('a', 'use', { connected: false }), net('b', 'standby', { status: 'standby' })],
        null
      )
    ).toEqual(['offline', 'on'])
  })

  it('a Standby network that is gone or at its limit says so, whatever the Use networks do', () => {
    expect(
      networkStatuses(
        [
          net('a', 'use'),
          net('b', 'standby', { connected: false }),
          net('c', 'standby', { atLimit: true })
        ],
        null
      )
    ).toEqual(['on', 'offline', 'limit'])
  })

  it('a Standby network the download has off stays off', () => {
    expect(
      networkStatuses([net('a', 'use'), net('b', 'standby', { enabled: false })], null)
    ).toEqual(['on', 'off'])
  })

  it('Don’t use never carries, gone or not; the download’s own off comes first', () => {
    expect(
      networkStatuses(
        [
          net('a', 'use'),
          net('b', 'never'),
          net('c', 'never', { connected: false }),
          net('d', 'never', { enabled: false })
        ],
        null
      )
    ).toEqual(['on', 'unused', 'unused', 'off'])
  })

  it('Don’t use does not count as a Use network: standby still takes over', () => {
    expect(networkStatuses([net('a', 'never'), net('b', 'standby')], null)).toEqual([
      'unused',
      'on'
    ])
  })

  it('switched back to Use, a network is on again', () => {
    expect(networkStatuses([net('a', 'use', { status: 'unused' })], null)).toEqual(['on'])
    expect(networkStatuses([net('a', 'use', { status: 'routed' })], null)).toEqual(['on'])
  })

  it('keeps how a trying network is doing', () => {
    expect(
      networkStatuses(
        [net('a', 'use', { status: 'unreachable' }), net('b', 'use', { status: 'failed' })],
        null
      )
    ).toEqual(['unreachable', 'failed'])
  })

  it('routing to one network wins over roles, Don’t use and Standby included', () => {
    const route = new Set(['b'])
    expect(
      networkStatuses([net('a', 'use'), net('b', 'never'), net('c', 'standby')], route)
    ).toEqual(['routed', 'on', 'routed'])
    expect(networkStatuses([net('a', 'use'), net('b', 'standby')], route)).toEqual(['routed', 'on'])
  })

  it('routing that waits for its network: nothing carries, whatever the roles', () => {
    expect(networkStatuses([net('a', 'use'), net('b', 'standby')], new Set())).toEqual([
      'routed',
      'routed'
    ])
  })

  it('routing to a network that is gone or at its limit says so', () => {
    expect(
      networkStatuses(
        [net('a', 'use', { connected: false }), net('b', 'use', { atLimit: true })],
        new Set(['a', 'b'])
      )
    ).toEqual(['offline', 'limit'])
  })
})
