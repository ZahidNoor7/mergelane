import { describe, expect, it } from 'vitest'
import {
  isAfterQueue,
  nextStartAt,
  QUEUE_END_COUNTDOWN_MS,
  queueBusy,
  queueEndAfter,
  type QueueItem
} from './queueEnd'

const T = 1_800_000_000_000
const item = (fields: Partial<QueueItem>): QueueItem => ({ status: 'completed', ...fields })

describe('whether the queue has work left', () => {
  it('has while one runs, or waits for a turn', () => {
    expect(queueBusy([item({ status: 'downloading' })])).toBe(true)
    expect(queueBusy([item({ status: 'queued' })])).toBe(true)
  })

  it('has none when what is left waits for a time, the schedule, or the user', () => {
    expect(queueBusy([])).toBe(false)
    expect(
      queueBusy([
        item({ status: 'queued', startAt: T + 3600_000 }),
        item({ status: 'queued', scheduled: true }),
        item({ status: 'paused' }),
        item({ status: 'error' }),
        item({ status: 'cancelled' }),
        item({ status: 'completed' })
      ])
    ).toBe(false)
  })
})

describe('the first time one waits for', () => {
  it('is the earliest start time of those waiting for one', () => {
    expect(nextStartAt([])).toBeUndefined()
    expect(
      nextStartAt([
        item({ status: 'queued', startAt: T + 2 }),
        item({ status: 'queued', startAt: T + 1 }),
        item({ status: 'paused', startAt: T })
      ])
    ).toBe(T + 1)
  })
})

describe('the countdown at the end of the queue', () => {
  it('starts a minute’s countdown to sleep or shut down when nothing is left', () => {
    expect(queueEndAfter('sleep', [item({})], T)).toEqual({
      action: 'sleep',
      endsAt: T + QUEUE_END_COUNTDOWN_MS
    })
    expect(queueEndAfter('shutdown', [], T)?.action).toBe('shutdown')
  })

  it('says when a download waiting for a time would have started', () => {
    expect(queueEndAfter('sleep', [item({ status: 'queued', startAt: T + 5 })], T)).toEqual({
      action: 'sleep',
      endsAt: T + QUEUE_END_COUNTDOWN_MS,
      nextStartAt: T + 5
    })
  })

  it('starts none when set to do nothing, or while work is left', () => {
    expect(queueEndAfter('nothing', [], T)).toBeNull()
    expect(queueEndAfter('shutdown', [item({ status: 'queued' })], T)).toBeNull()
  })
})

describe('the setting', () => {
  it('is one of its three values', () => {
    expect(['nothing', 'sleep', 'shutdown'].every(isAfterQueue)).toBe(true)
    expect(isAfterQueue('hibernate')).toBe(false)
    expect(isAfterQueue(undefined)).toBe(false)
  })
})
