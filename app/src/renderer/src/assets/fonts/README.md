# Fonts

Bundled offline (CLAUDE.md: no third-party requests). Both are under the SIL Open Font License 1.1; each licence
text sits beside its font, so it ships with the app and with the browser extension, which copies this folder
(`extension/build.mjs`). They are also in `THIRD-PARTY-NOTICES.md`.

| File                         | Font                                                            | Source (google/fonts, pinned commit)                                                      | SHA-256 of the source TTF                                          | SHA-256 of the woff2                                               |
| ---------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `Archivo-Variable.woff2`     | Archivo, by Omnibus-Type; axes `wght` 100–900 and `wdth` 62–125 | `ofl/archivo/Archivo[wdth,wght].ttf` at `95f4904fc8bcf26d3420fe315560c96417c6dec7`        | `0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053` | `bd503603e2072c980a82c759de7e52f46fc0515897aa304666ae76c8469b4f79` |
| `FragmentMono-Regular.woff2` | Fragment Mono Regular, by Wei Huang and URW Design Studio       | `ofl/fragmentmono/FragmentMono-Regular.ttf` at `8f6cd0c1cdf938a8a31e246d8a9ba09b5f6cc830` | `0fe011f425873c2e0fc73a189e394e340ad48d2b9a99a576bdeec75cee000460` | `5a78d42f4695530b327e62a4b1f01df2eaeef8f832187384ef2a11acfd48d255` |

- The licence, designer and axes come from each family's `METADATA.pb` and `OFL.txt` at those commits. Neither
  licence names a Reserved Font Name.
- The woff2 files are the TTFs re-wrapped with fontTools 4.60.1 (`TTFont(...).flavor = 'woff2'`, with brotli 1.1.0).
  Every glyph and feature is kept, and no subsetting is done. Archivo keeps its `tnum` feature, which the `figures`
  utility in `main.css` needs.
