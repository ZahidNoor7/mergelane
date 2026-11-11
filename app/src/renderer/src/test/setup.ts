// Runs before every Vitest file (vitest.config.ts). Two jobs:
// 1. Testing Library's cleanup after each test. Its automatic cleanup needs Vitest's globals, which
//    are off here, so it is called by hand, as Testing Library's setup docs show.
// 2. A stand-in for the preload bridge. Renderer modules read window.mergelane when they load
//    (theme.ts's platform, the store's initial state), before any test can set it up. Tests that
//    call one of its methods add that method themselves, so a missing one fails loudly.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { InitialState } from '@shared/types'

const initialState: InitialState = {
  homeDir: '/Users/test',
  downloadsDir: '/Users/test/Downloads',
  themeSource: 'light',
  networkPreferences: {},
  downloadsAtOnce: 3,
  slowMode: false,
  slowModeSpeed: 2_000_000,
  speedUnit: 'bytes'
}

Object.defineProperty(window, 'mergelane', {
  configurable: true,
  writable: true,
  value: { platform: 'darwin', initialState }
})

afterEach(() => {
  cleanup()
})
