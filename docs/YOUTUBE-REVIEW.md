# YouTube options review

Milestone M2.2. Prepared 2026-11-10. Status: decided 2026-11-11, option A for YouTube plus D for other sites (ADR-0026); implemented in M2.2 YouTube.

**This is information to help you choose, not legal advice.** Anything I could not check says "not verified".

## The short answer

- Every option that actually gets YouTube videos (A, B, C, F) downloads in a way YouTube's Terms do not allow.
  The choice is how far each goes, and how much it could break or harm users.
- Recommended: **A** (yt-dlp, no cookies) for YouTube, plus **D** for other sites. Rule out C and F for now.

## What the rules say

**CLAUDE.md:** "No DRM circumvention. No private or sign-in-only media beyond what the user's own browser session
legitimately provides."

**YouTube Terms of Service**, English (US) version, "Dated: December 15, 2023"
(<https://www.youtube.com/t/terms?hl=en&gl=US>, same text at
<https://www.youtube.com/static?template=terms&hl=en&gl=US>). Under "Permissions and Restrictions", you are not
allowed to:

> 1. access, reproduce, download, distribute, transmit, broadcast, display, sell, license, alter, modify or otherwise
>    use any part of the Service or any Content except: (a) as expressly authorized by the Service; or (b) with prior
>    written permission from YouTube and, if applicable, the respective rights holders;
> 2. circumvent, disable, fraudulently engage with, or otherwise interfere with any part of the Service (or attempt
>    to do any of these things), including security-related features or features that (a) prevent or restrict the
>    copying or other use of Content or (b) limit the use of the Service or Content;
> 3. access the Service using any automated means (such as robots, botnets or scrapers) except (a) in the case of
>    public search engines, in accordance with YouTube's robots.txt file; or (b) with YouTube's prior written
>    permission;

Item 9 limits use to "personal, non-commercial use". Terms vary by country; this machine's default page was a
translated version dated 5 January 2022.

**Courts.** In 2020 GitHub restored youtube-dl (yt-dlp's parent project), finding "the project was not
circumventing a technical protection measure". A German appeal court (OLG Hamburg, 21 November 2024, 5 U 54/23)
treated YouTube's "rolling cipher" as "an effective measure" in a case against youtube-dl's website host. Results
differ by country.

## The options

### A. yt-dlp only, no cookies

- **How it works:** Mergelane gives the video's link (pasted, or seen by the extension) to yt-dlp, a separate
  program, which fetches it as a signed-out visitor. FFmpeg joins sound and picture.
- **Needs from the browser:** only the link.
- **CLAUDE.md:** fits; public videos only. yt-dlp drops formats it knows are DRM-protected but keeps ones marked
  "maybe" (`YoutubeDL.py`). Mergelane must drop those too and never pass `--allow-unplayable-formats`.
- **Terms:** outside items 1 and 3, like B, C and F.
- **Licence:** the source is the Unlicense, but the official macOS binary is built with PyInstaller, and the README
  says such executables "include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+".
  Ship it like FFmpeg, with a source offer; `THIRD-PARTY-NOTICES.md` currently says Unlicense.
- **Hidden extra:** yt-dlp needs a JavaScript runtime for YouTube; Deno (MIT) is recommended (wiki, "EJS").
  Awesome Downloader ran the Electron app as Node, which ADR-0016 turns off, so Mergelane would ship Deno too.
- **Limits:** without a PO token (see C), "some formats and features may not be available" (wiki).
- **Maintenance:** high, but yt-dlp's team does it: 13 of its 14 releases from November 2025 to October 2026
  included YouTube changes. Each break needs a Mergelane release.

### B. yt-dlp with the user's own cookies

- **How it works:** as A, plus the user's YouTube login cookies, so it can fetch age-restricted, members-only or
  private videos the user can watch.
- **Needs from the browser:** login cookies. yt-dlp can read Chrome's store itself (on macOS via the Keychain item
  "Chrome Safe Storage", `cookies.py`), or the extension passes them, as it already does for normal downloads
  (`app/src/main/download/browserContext.ts`).
- **CLAUDE.md:** allowed in principle (the user's own session). The app must never log or save the cookies.
- **Terms:** as A, plus a risk to the user. yt-dlp's wiki: "By using your account with yt-dlp, you run the risk of
  it being banned (temporarily or permanently)." YouTube also "rotates account cookies frequently on open YouTube
  browser tabs", so copied cookies can stop working.
- **Licence and maintenance:** as A, plus expiring cookies. Some signed-in cases use clients that "require a
  `po_token`" (README), so B may not work without F.

### C. Replay the player's own stream (Awesome Downloader)

- **How it works:** the user plays the video. The extension copies the player's streaming request, which carries
  a proof-of-origin (PO) token, and the headers sent with it (cookie, authorization, user agent, referer, origin,
  when present). The app decodes the token and uses the `googlevideo` library to keep asking YouTube's servers
  for the chosen tracks as if it were that player (`core/sabr.mjs`, `extension/background.js`).
- **Needs from the browser:** request bodies and headers, including cookies.
- **CLAUDE.md:** DRM formats are filtered out (`extension/youtube-media.js`) and it uses only what the user's
  session produced. But the PO token exists, in yt-dlp's words, "to attest the requests are coming from a genuine
  client". Reusing it from another program is the option nearest Terms item 2 ("security-related features").
  Whether that is circumvention is a legal question this paper cannot answer.
- **Licence:** `googlevideo` is MIT (GitHub LICENSE; npm 5.0.1) and runs inside the app.
- **Maintenance:** highest. It depends on YouTube's internal protocol and page data; `googlevideo` had five major
  versions from October 2024 to October 2026 (npm), and we would carry the fixes. CI fixtures would hold tokens
  and signed URLs, which CLAUDE.md forbids committing.

### D. Streams the page already loads

- **How it works:** the extension lists plain media files and HLS/DASH playlists a page loads; no site-specific
  code.
- **YouTube in practice:** almost nothing. YouTube's web player uses its own protocol (yt-dlp wiki: the `web`
  client has "Only SABR formats available"; Awesome Downloader notes plain URLs "can be unusable (403)").
- **CLAUDE.md:** fits, if Mergelane detects and refuses DRM-encrypted streams (an M2.2 design task).
- **Licence and maintenance:** FFmpeg only; low.

### E. No YouTube support

No YouTube Terms exposure. CLAUDE.md and the README list YouTube as a goal, so this needs you to change them.

### F. yt-dlp plus a token-generator plugin (found during this review)

- **How it works:** a plugin makes PO tokens outside the browser, e.g. `bgutil-ytdlp-pot-provider` (GPL-3.0),
  which runs YouTube's BotGuard check via `BgUtils` (MIT). yt-dlp's wiki calls this the "recommended setup".
- **Concern:** it makes the "genuine client" proof without the genuine client, so it sits closer to Terms item 2
  than C. Breakage is high: "YouTube is continuously updating the implementation and enforcement" (wiki).

## What other open-source download managers do

- Persepolis lists "Downloading videos from Youtube" and credits yt-dlp.
- Parabolic is "A powerful yt-dlp frontend" and warns videos "may be subject to DMCA protection".
- Open Video Downloader wraps yt-dlp, "supports browser cookie files" and updates yt-dlp automatically.
- The READMEs of Plexo (our upstream), Motrix, Gopeed and AB Download Manager do not mention YouTube.
- None of these READMEs describes option C.

## Comparison

| | What it can get | Takes from the browser | Fits CLAUDE.md | Terms items | Licence | Breaks often |
| --- | --- | --- | --- | --- | --- | --- |
| A | Public videos, some formats missing | Link only | Yes | 1, 3 | GPLv3+ binary, plus Deno (MIT) | Yes; fixes come fast |
| B | Adds signed-in videos (may need F) | Login cookies | Yes, with care | 1, 3; account risk | As A | Yes, plus cookies |
| C | Videos the user can play | Stream request, token, cookies | Debatable | 1, 2, 3 | MIT | Most |
| D | Almost nothing on YouTube | Media links | Yes | None for YouTube | FFmpeg only | Rarely |
| E | Nothing | Nothing | Yes | None | None | No |
| F | Public videos, more formats | Link only | Debatable | 1, 2, 3 | GPL-3.0 plugin | Most |

"What it can get" is from documentation and code, not a test run (not verified).

## Recommendation

Choose **A for YouTube and D for other sites**, with these limits written into CLAUDE.md:

- no cookies, and no PO tokens, captured or generated;
- drop every format marked DRM or "maybe" DRM;
- only links the user pasted or opened.

Reasons:

- The app needs only a link, so it never holds a login or a token.
- It matches the other open-source download managers and the existing plan (pinned yt-dlp, separate executable).
- It avoids the token use in C and F, the part nearest the "security-related features" clause.
- yt-dlp's team ships YouTube fixes about monthly; with C, we would.

The cost: some videos will fail, and A is still outside Terms items 1 and 3.

## What you need to decide

1. Is any YouTube download acceptable, given that A, B, C and F are all outside YouTube's Terms? If not, choose
   D and E, and update CLAUDE.md and the README.
2. If yes, approve A (with D) as the only YouTube approach for Phase 2.
3. Approve shipping Deno as a third pinned program (ADR-0016 stops the app acting as Node).
4. Cookies (B): never, or later as an off-by-default setting with an account-ban warning?
5. Rule out C and F in CLAUDE.md, or leave them open?
6. Get a lawyer's view before release, given the German ruling?

## Sources (fetched 2026-11-10)

- YouTube Terms: the two URLs above (plain <https://www.youtube.com/t/terms> gave a translated 2022 version).
- yt-dlp: <https://github.com/yt-dlp/yt-dlp> (LICENSE, README, `YoutubeDL.py`, `cookies.py`, `build.yml`, release
  notes) and its wiki (Extractors, PO Token Guide, EJS).
- googlevideo: <https://github.com/LuanRT/googlevideo> and <https://www.npmjs.com/package/googlevideo>
- Awesome Downloader at `d99dbe0e`: `core/sabr.mjs`, `core/youtube.mjs`, `extension/youtube-media.js`,
  `extension/background.js`, `THIRD-PARTY.md`.
- GitHub API licences: Deno, bgutil-ytdlp-pot-provider, BgUtils.
- <https://github.blog/news-insights/policy-news-and-insights/standing-up-for-developers-youtube-dl-is-back/> and
  <https://heise.de/-10181247>
- GitHub READMEs: Persepolis, Parabolic, Open Video Downloader, Plexo, Motrix, Gopeed, AB Download Manager.
