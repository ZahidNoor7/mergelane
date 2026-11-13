# The browser extension's licence

The Mergelane browser extension, as built by `build.mjs` and shipped inside the app, includes uBO Lite
(uBlock Origin Lite), copyright (C) 2022-present Raymond Hill and contributors, which is licensed under the
GNU General Public License, version 3 or later (ADR-0063). The extension as a whole is therefore distributed
under **GPL-3.0-or-later**. The full licence text is `LICENSE.txt` in every built extension folder, and
https://www.gnu.org/licenses/gpl-3.0.txt.

Mergelane's own code in this folder (`src/`, `build.mjs`, `manifest.json`) stays available under the MIT licence
in `../LICENSE`, as does the code it derives from Plexo (`THIRD-PARTY-NOTICES.md`). MIT code may be combined into
a GPL work; the combination is what is under the GPL.

uBO Lite itself is not committed here: `scripts/adblock/ubol.mjs` fetches its official release build, pinned by
SHA-256 in `scripts/adblock/ubol.json`, at build time. Its source code, the gorhill/uBlock commit those builds were
made from, is attached to every Mergelane release as `ubo-lite-<version>-source.tar.gz`. Mergelane's changes to it
are the `PATCHES` list in `scripts/adblock/ubol.mjs`, and the names and images `brandLocales` and `brandImages`
replace there.
