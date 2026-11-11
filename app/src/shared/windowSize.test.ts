import { describe, expect, it } from 'vitest'
import { DESIGN_WINDOW, MIN_WINDOW, openingSize } from './windowSize'

describe('openingSize', () => {
  it('opens at the design’s size when the screen has room', () => {
    expect(openingSize({ width: 1728, height: 1079 })).toEqual(DESIGN_WINDOW)
  })

  it('fits a smaller work area, in whole points', () => {
    expect(openingSize({ width: 1200.5, height: 760.4 })).toEqual({ width: 1200, height: 760 })
  })

  it('never opens below the smallest window', () => {
    expect(openingSize({ width: 600, height: 500 })).toEqual(MIN_WINDOW)
  })
})
