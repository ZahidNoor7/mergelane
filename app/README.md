# Mergelane app

The Electron app: download engine, torrents, Usenet, scheduler, limits, renderer UI and the browser bridge.
It started as an import of [Plexo](https://github.com/anmolkapil/plexo) (MIT, Copyright (c) 2026 Anmol Kapil);
see `../docs/UPSTREAM.md` for the exact commit and what Mergelane changed.

Requirements: macOS 27 or later on Apple silicon, and Node.js 22 or later.

```sh
npm ci                  # installs dependencies, applies patches/, downloads Electron
npm run dev             # run with hot reload
npm run lint            # ESLint
npm run typecheck       # main, renderer, e2e and extension
npm run format:check    # Prettier
npm run test:e2e        # Playwright: unit-style specs and app launches
npm run test:e2e:smoke  # the quick subset CI runs on every pull request
npm run build:mac       # arm64 DMG and zip in dist/, ad-hoc signed
npm run build:extension # browser extension into extension/dist/
```

The DMG is ad-hoc signed (`identity: "-"` in `electron-builder.yml`), because there is no Apple Developer ID
yet. `../scripts/ci/package-test.sh` checks it the way a user installs it.
