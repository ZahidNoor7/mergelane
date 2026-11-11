# Browser bridge, protocol v2 (native messaging)

How the browser extension hands downloads to the app (ADR-0021). There are three processes:

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
- **Request:** one line of JSON, `{"v":2,"origin":"<caller>","message":<extension message>}`, then a newline. The
  app answers with one line of JSON and closes the connection.
- **App not running:** if the socket is missing or refuses the connection, the host answers
  `{"ok":false,"error":"unavailable"}` for every message except `wake`.
  - For `wake`, the host starts the app (`/usr/bin/open -g -b io.github.zahidnoor7.mergelane`).
  - It then retries the connection every 250 ms for up to 10 s.
  - `MERGELANE_NMHOST_NO_LAUNCH=1` disables the launch, for tests.

## Messages (extension → app) and answers

| Message | Answer |
|---|---|
| `{"type":"ping"}` | `{"ok":true,"app":"mergelane","version":"<v>","api":2}` |
| `{"type":"wake"}` | Same as `ping`, once the app answers. The host starts the app first if it isn't running. |
| `{"type":"add","request":<BridgeAddRequest>}` | `{"ok":true,"token":"<uuid>"}` when Mergelane will take the download, or `{"ok":false,"kept":"<reason>"}` when the browser should keep it. Answered within 8 s. |
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
