import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Unit tests for renderer code (ADR-0034): React components and hooks in jsdom, with V8 coverage.
// Playwright keeps the end-to-end tests in e2e/; it never runs these files, and Vitest never runs
// those (its include is only *.test.* files under src/renderer and src/shared).
//
// Coverage is enforced per file on the files listed here, at 90% of lines: a renderer file joins
// the list in the pull request that changes it, so new and reworked code is held to the floor
// while untouched upstream files are not counted against it.
export const COVERED = [
  'src/renderer/src/theme.ts',
  'src/renderer/src/components/ui/switch.tsx',
  'src/shared/themes.ts',
  'src/renderer/src/theme/appearance.ts',
  'src/renderer/src/hooks/usePrefersDark.ts',
  'src/renderer/src/components/ThemeToggle.tsx',
  // M3.1 pull request 3: the basic controls.
  ...[
    'alert',
    'alert-dialog',
    'badge',
    'button',
    'checkbox',
    'context-menu',
    'dialog',
    'dropdown-menu',
    'input',
    'input-group',
    'popover',
    'textarea',
    'toggle',
    'toggle-group'
  ].map((name) => `src/renderer/src/components/ui/${name}.tsx`),
  // M3.1 pull request 4a: the chunk map, split bar, speed chart and sparkline.
  ...['BlockGrid', 'SplitBar', 'ThroughputChart', 'Sparkline'].map(
    (name) => `src/renderer/src/components/${name}.tsx`
  ),
  // Networks' colours kept apart from the theme's (theme.ts assignNetworkColors).
  'src/shared/colour.ts',
  'src/renderer/src/hooks/useNetworkVisuals.ts',
  // M3.1 pull request 4b: the Confluence.
  'src/renderer/src/components/Confluence.tsx',
  // M3.1 pull request 5a: the window's frame (sidebar and compact bar) and its parts.
  ...['WindowChrome', 'NetworkTile', 'SpeedText', 'SpeedUnitToggle'].map(
    (name) => `src/renderer/src/components/${name}.tsx`
  ),
  'src/renderer/src/hooks/useElementWidth.ts',
  // M3.1 pull request 5b-1: the download list, its filters and its rows.
  'src/renderer/src/screens/DownloadsScreen.tsx',
  ...['DownloadFilters', 'DownloadGlyphs'].map((name) => `src/renderer/src/components/${name}.tsx`),
  'src/renderer/src/components/fileTypeIcons.ts',
  'src/renderer/src/hooks/useMergeLanes.ts',
  'src/shared/downloadFilters.ts'
]

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    root: '.',
    include: ['src/renderer/**/*.test.{ts,tsx}', 'src/shared/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['src/renderer/src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: COVERED,
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { perFile: true, lines: 90 }
    }
  }
})
