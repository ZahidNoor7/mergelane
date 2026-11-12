# Browser bridge, protocol v3 (native messaging)

How the browser extension hands downloads to the app (ADR-0021). Chrome, Chromium and Microsoft Edge load the
Chrome build; Firefox loads its own (ADR-0038). There are three processes:

```text
extension ──native messaging──► mergelane-nmhost ──Unix socket──► Mergelane.app
 (Chrome/Firefox)  stdin/stdout, 32-bit         (Go, in the app     ~/Library/Application Support/
                   length + UTF-8 JSON           bundle)             Mergelane/browser.sock (0600)
```

## Extension ↔ host

Uses Chrome's native messaging, verified against
<https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>.

- **Host name:** `io.github.zahidnoor7.mergelane`. The manifest file is `io.github.zahidnoor7.mergelane.json`.
- **Framing:** each message is a 32-bit length in native byte order (little endian on Apple silicon), followed by
  that many bytes of UTF-8 JSON.
- **Size limits:** host → browser at most 1 MiB; browser → host at most 64 MiB. The host refuses more than 1 MiB
  in either direction, because no bridge message needs that much.
- **One host per message:** the extension uses `chrome.runtime.sendNativeMessage`, so the browser starts one host
  process per message. The host answers it and exits.
- **Caller:**
  - Chrome passes the caller's origin as `argv[1]` (`chrome-extension://<id>/`).
  - Firefox passes the manifest path as `argv[1]` and the extension ID as `argv[2]`.
  - The host forwards whichever one identifies the caller.

## Host ↔ app

- **Socket:** a Unix stream socket. The path comes from `MERGELANE_BROWSER_SOCKET`, else
  `$HOME/Library/Application Support/Mergelane/browser.sock`. The app creates it with mode 0600, so only the user's
  own processes can connect.
- **Request:** one line of JSON, `{"v":3,"origin":"<caller>","browser":"<path>","message":<extension message>}`,
  then a newline. The app answers with one line of JSON and closes the connection.
  - `browser` (v3) is the executable of the process that started the host, as `/bin/ps -o comm= -p <parent pid>`
    reports it (for example `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`). It's left out when it
    can't be read. The app uses it only to show which browsers have connected (ADR-0039).
- **App not running:** if the socket is missing or refuses the connection, the host answers
  `{"ok":false,"error":"unavailable"}` for every message except `wake`.
  - For `wake`, the host starts the app (`/usr/bin/open -g -b io.github.zahidnoor7.mergelane`).
  - It then retries the connection every 250 ms for up to 10 s.
  - `MERGELANE_NMHOST_NO_LAUNCH=1` disables the launch, for tests.

## On Windows (W2, ADR-0056)

The protocol is the same; how the three find each other differs.

- **Registration:** the app keeps two manifests, `NativeMessagingHosts\chrome.json` and `firefox.json`, in its own
  folder (`%APPDATA%\Mergelane`). For each installed browser whose maker documents a key, it writes
  `HKCU\<key>\io.github.zahidnoor7.mergelane` with the manifest's path as the default value, on every start, as
  the browsers' docs give it (`reg add … /ve /t REG_SZ /d <manifest> /f`):
  - Chrome: `Software\Google\Chrome\NativeMessagingHosts` (developer.chrome.com);
  - Edge: `Software\Microsoft\Edge\NativeMessagingHosts` (learn.microsoft.com);
  - Firefox: `Software\Mozilla\NativeMessagingHosts` (developer.mozilla.org).
  - Chromium, Brave and Vivaldi document no Windows key, so they aren't supported there yet.
  - A run with its own `--user-data-dir` (the test kit) registers nothing. The uninstaller removes the keys (W4).
- **Arguments:** Chrome and Edge also pass `--parent-window=<handle>` after the origin. The host ignores it.
- **The pipe:** the app serves the bridge on a named pipe, `\\.\pipe\mergelane-browser-<16 hex digits>`: the
  SHA-256 of its folder's path with A-Z lowercased (`app/src/shared/browserPipe.ts`, `daemon/internal/nmhost/pipe.go`
  and the test kit, all tested against `shared/fixtures/browser-pipe.json`). The default security of a named pipe
  gives other users read access only, so they can't send a request (Microsoft Learn, "Named Pipe Security and
  Access Rights"). The host opens the pipe as an overlapped file, which Go makes pollable, so the reply timeout
  works (`go doc os.NewFile`).
- **Browser:** `browser` is the full path of the parent process (`QueryFullProcessImageName`). Edge may start the
  host through `cmd.exe`, which then shows instead.
- **Wake:** the host starts `Mergelane.exe` from the folder above its own (`<install>\resources\..`), with
  `CREATE_BREAKAWAY_FROM_JOB`: the browser puts the host in a job object and ends the job (MDN, "Native
  messaging"). If the job forbids breaking away, it starts it inside the job instead.

## Messages (extension → app) and answers

| Message | Answer |
|---|---|
| `{"type":"ping","extension":"<version>"}` | `{"ok":true,"app":"mergelane","version":"<v>","api":3,"rules":{"capture":<bool>,"videoButton":<bool>}}`. `extension` (v3) is the extension's version; `rules` (v3) is what the extension acts on itself: whether to send downloads at all, and whether to list a page's videos. |
| `{"type":"wake"}` | Same as `ping`, once the app answers. The host starts the app first if it isn't running. |
| `{"type":"add","request":<BridgeAddRequest>}` | `{"ok":true,"token":"<uuid>"}` when Mergelane will take the download, or `{"ok":false,"kept":"<reason>"}` when the browser should keep it. Answered within 8 s. The app applies Settings › Browser extensions' rules here (sending on or off, the minimum size, the file types), so every browser follows the same ones. |
| `{"type":"confirm","token":"<uuid>"}` | `{"ok":true}`, or `{"ok":false}` when the token is unknown or expired (15 s). |
| `{"type":"health"}` | `{"ok":true,"app":"mergelane","version":"<v>","ready":<bool>}`. Used by packaging tests through the socket; never sent by the extension. |

Errors the host or app can answer for any message:

- `{"ok":false,"error":"unavailable"}`: the app isn't running.
- `{"ok":false,"error":"bad-message"}`: not JSON, wrong shape, or too big.
- `{"ok":false,"error":"forbidden"}`: the caller isn't one of our extensions.
- `{"ok":false,"error":"unsupported"}`: an unknown message type, or a version mismatch.

## Who may call

The app accepts only its own extensions' callers:

- Chrome: `chrome-extension://<id>/`, with the ID fixed by the `key` in `app/extension/manifest.json`.
- Firefox: the add-on ID `mergelane@zahidnoor7.github.io`.

This is defence in depth. Any program running as the same user could launch the host or connect to the socket
itself (ADR-0021).

## Videos on the page (extension only)

The extension also lists the HLS and DASH manifests a tab loads, and hands one over with the same `add` message.
See ADR-0023.

- **Detection:** it only observes `webRequest.onHeadersReceived` (the `webRequest` permission). It never blocks or
  changes a request and never reads a body.
- **Storage:** lists are kept per tab in `storage.session` and cleared on navigation and when the tab closes.
- **Popup messages:** `{mediaOf}` and `{sendMedia}`. These stay inside the extension.
- **Not listed:** YouTube hosts, pending the owner's decision (`docs/YOUTUBE-REVIEW.md`).
