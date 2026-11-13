import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // resources/bin and resources/bin-win hold the fetched media tools (scripts/media-tools/fetch.mjs): yt-dlp's folder
  // carries third-party JavaScript that is not ours to lint, as does extension/.cache, uBO Lite's pinned builds
  // (scripts/adblock/ubol.mjs, ADR-0063).
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'resources/bin',
      'resources/bin-win',
      'extension/.cache',
      // Gauge UI, copied from upstream at a pinned commit (ADR-0064): kept as upstream wrote it.
      'src/renderer/src/components/gauge'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // Playwright fixtures call a parameter named `use`, which the React hooks rule mistakes for
    // React's use() hook.
    files: ['e2e/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' }
  },
  {
    // Plain JavaScript that runs as-is — the download page's script, and the CommonJS and ES module
    // scripts that Electron and node load directly — so TypeScript's conventions (return types,
    // import syntax) don't apply.
    files: ['docs/**/*.js', 'e2e/page-host/*.cjs', 'scripts/**/*.mjs', 'extension/build.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  eslintConfigPrettier
)
