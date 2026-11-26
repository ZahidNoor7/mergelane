import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Unit tests for renderer code (ADR-0034): React components and hooks in jsdom, with V8 coverage.
// Playwright keeps the end-to-end tests in e2e/; it never runs these files, and Vitest never runs
// those (its include is only *.test.* files under src/renderer, src/shared and extension/src).
//
// Coverage is enforced per file on the files listed here, at 90% of lines: a renderer file joins
// the list in the pull request that changes it, so new and reworked code is held to the floor
// while untouched upstream files are not counted against it.
export const COVERED = [
  // Windows (W1): which adapters are networks, and of what kind.
  'src/shared/windowsAdapters.ts',
  'src/shared/loginItem.ts',
  'src/shared/windowMaterial.ts',
  'src/renderer/src/platformWords.ts',
  // Windows (W2): the browser bridge's pipe, and the browsers on Windows.
  'src/shared/browserPipe.ts',
  'src/shared/browsers.ts',
  // Windows (W5): the system-wide helper's install through the administrator prompt.
  'src/shared/windowsHelper.ts',
  // Windows (W7): the notification-area icon's flyout and menu (ADR-0061).
  'src/shared/trayFlyout.ts',
  'src/renderer/src/components/TrayFlyout.tsx',
  'src/renderer/src/hooks/useTrayStatus.ts',
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
  'src/renderer/src/utils/downloadActions.ts',
  // M3.10: each network's role for downloads (ADR-0045).
  'src/shared/networkRoles.ts',
  'src/renderer/src/components/NetworkRoleMenu.tsx',
  // ADR-0046: Remove helper, in the System merge section.
  'src/renderer/src/components/SystemMergeSection.tsx',
  'src/renderer/src/hooks/useSystemMerge.ts',
  // ADR-0051: the sidebar offers the helper's update as soon as Mergelane opens.
  'src/renderer/src/components/HelperUpdateNotice.tsx',
  // ADR-0052: tunnels aren't offered as networks.
  'src/shared/tunnels.ts',
  // ADR-0063: the browser extension's ad blocking (uBO Lite) and the settings it shares storage with.
  'extension/src/adblock.ts',
  'extension/src/settings.ts',
  // The extension's settings page, redrawn as the app's Settings (options.html).
  'extension/src/options.ts',
  // ADR-0064: the speed test's numbers and its saved history, and its view in Networks.
  'src/shared/speedTest.ts',
  'src/renderer/src/utils/speedTest.ts',
  'src/renderer/src/hooks/useSpeedTest.ts',
  ...['SpeedGauge', 'SpeedTestView', 'SpeedTestResults', 'SpeedTestHistory'].map(
    (name) => `src/renderer/src/components/speedTest/${name}.tsx`
  ),
  // ADR-0067: the menu under the macOS menu bar icon.
  'src/shared/menuBarPanel.ts',
  'src/renderer/src/components/MenuBarPanel.tsx',
  'src/renderer/src/hooks/useMenuBarData.ts',
  // ADR-0070: the Dashboard's total speed, all apps, and the glass lens.
  'src/shared/interfaceCounters.ts',
  'src/renderer/src/components/GlassLens.tsx',
  'src/renderer/src/hooks/useNetworkTraffic.ts',
  // Electron 45: secrets sealed with safeStorage's asynchronous calls.
  'src/shared/sealing.ts',
  // Crash-safe resume (docs/plans/2026-11-new-features-plan.md, feature 5): the save order, the
  // crash rules, the recovery note and the Settings row.
  'src/shared/journal.ts',
  'src/shared/recovery.ts',
  'src/renderer/src/components/RecoveredBanner.tsx',
  'src/renderer/src/components/SafetySettings.tsx',
  // Expired-link recovery (feature 6): the rules, the fresh-link panel and its note.
  'src/shared/linkExpiry.ts',
  'src/renderer/src/components/inspector/FreshLink.tsx',
  'src/renderer/src/utils/format.ts',
  // Sleep and the end of the queue (feature 7): the rules, the commands, the notice and the rows.
  'src/shared/queueEnd.ts',
  'src/shared/powerCommand.ts',
  'src/renderer/src/components/QueueEnd.tsx',
  // Choosing a torrent's files (feature 9): its folders, and the list.
  'src/shared/torrentTree.ts',
  'src/renderer/src/components/TorrentFiles.tsx',
  // Download history (Phase 2, ADR-0080): what is shown and kept, the place and its settings.
  'src/shared/history.ts',
  'src/renderer/src/screens/HistoryScreen.tsx',
  'src/renderer/src/components/HistorySettings.tsx',
  // Duplicates (ADR-0081): a site's published SHA-256, the match rules, the notice and its lookup.
  'src/shared/digests.ts',
  'src/shared/duplicates.ts',
  'src/renderer/src/components/DuplicateNotice.tsx',
  'src/renderer/src/hooks/useDuplicate.ts'
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
    include: [
      'src/renderer/**/*.test.{ts,tsx}',
      'src/shared/**/*.test.ts',
      'extension/src/**/*.test.ts'
    ],
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
