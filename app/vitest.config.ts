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
  'src/shared/downloadFilters.ts',
  // M3.1 pull request 5b-2: a download's details (the Inspector) and where they sit.
  ...['Inspector', 'InspectorProgress', 'InspectorFinished', 'InspectorFailed', 'parts'].map(
    (name) => `src/renderer/src/components/inspector/${name}.tsx`
  ),
  'src/renderer/src/components/DownloadNetworks.tsx',
  'src/renderer/src/components/networkStatus.ts',
  'src/renderer/src/screens/DownloadsPlace.tsx',
  'src/shared/windowSize.ts',
  // M3.1 pull request 5c: New download as the design's sheet.
  'src/renderer/src/components/NewDownloadDialog.tsx',
  // M3.1 pull request 5d: the Networks screen.
  'src/renderer/src/screens/NetworksScreen.tsx',
  'src/renderer/src/components/NetworkEditPopover.tsx',
  // M3.1 pull request 5e: Settings.
  'src/renderer/src/screens/SettingsScreen.tsx',
  // M3.2 pull request a: the update check and Settings › Updates.
  'src/shared/releases.ts',
  ...['UpdateSettings', 'UpdateNotice', 'settingsParts'].map(
    (name) => `src/renderer/src/components/${name}.tsx`
  ),
  'src/renderer/src/hooks/useUpdates.ts',
  // M3.3: the menu bar, Open at login and notifications.
  'src/shared/speedText.ts',
  'src/renderer/src/components/OnThisMacSettings.tsx',
  // M3.4a: Settings › Browser extensions.
  'src/shared/browsers.ts',
  'src/shared/captureRules.ts',
  'src/renderer/src/components/ExtensionSettings.tsx',
  'src/renderer/src/components/settingsParts.tsx',
  // M3.5a: routing downloads to one network.
  'src/renderer/src/components/RoutingPanel.tsx',
  'src/renderer/src/components/networkStatus.ts',
  // M3.5b: routing uploads, and upload limits.
  'src/shared/routing.ts',
  'src/renderer/src/components/LimitsDialog.tsx',
  'src/renderer/src/hooks/useSettingsShortcut.ts',
  // M3.6: Offer links I copy.
  'src/shared/links.ts',
  'src/renderer/src/components/CopiedLinkOffer.tsx',
  'src/renderer/src/hooks/useCopiedLinks.ts',
  // M3.1 pull request 6a: the Dashboard's Today.
  'src/renderer/src/components/DashboardToday.tsx',
  // M3.1 pull request 6b: Mergelane on this Mac.
  'src/renderer/src/components/UsagePanel.tsx',
  'src/shared/appUsage.ts',
  // M3.1 pull request 7: Liquid Glass.
  'src/renderer/src/hooks/useGlassAttributes.ts',
  // M3.7: diagnostics, and Today and the dropouts kept across restarts.
  'src/shared/networkActivity.ts',
  'src/shared/diagnostics.ts',
  'src/renderer/src/components/DiagnosticsSettings.tsx',
  'src/renderer/src/hooks/useNetworks.ts',
  // M3.9: New download's When (ADR-0044).
  'src/shared/startAt.ts',
  'src/renderer/src/utils/downloadActions.ts'
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
