#!/usr/bin/env bash
# Packaging test (Phase 1 acceptance criterion 1, docs/DECISIONS.md ADR-0013).
#
# Installs the DMG the way a user does and checks that the app reaches its ready state:
#   mount -> copy the app out -> mark it quarantined -> verify every signature and the bundle
#   metadata -> check Gatekeeper's verdict is "unnotarised" (Open Anyway), not "damaged" ->
#   remove quarantine (the README's install step) -> open -> ask the bridge socket's health until ready -> quit.
#
# Local mode (--local, or MERGELANE_PACKAGE_TEST_LOCAL=1) is for the owner's Mac, where CI's way of
# testing would reach the owner's own Mergelane (docs/RELEASING.md, "Checking a build on this Mac"):
#   - no quarantine flag is ever set, so macOS never shows its "could not verify" dialog, and the
#     Gatekeeper assessment that needs the flag is skipped (both are said in the output). A DMG that
#     already carries the flag is refused.
#   - the app is started directly, not with `open`, with its own home and data folders:
#     CFFIXED_USER_HOME and HOME point at an empty folder (Electron's home, Library, Downloads and
#     log paths follow CoreFoundation's home, which honours CFFIXED_USER_HOME), and --user-data-dir
#     gives it its own userData, so its single-instance lock can't reach a running Mergelane.
#     --use-mock-keychain keeps Chromium's cookie key out of the login keychain.
#   - it quits by its process ID, never by bundle ID (which could quit the owner's Mergelane).
#   - before and after, it records the owner's Mergelane folders, the browsers' native messaging
#     host folders, Mergelane's keychain item and its link handlers, and fails if anything changed.
#     The temporary copy's LaunchServices registration is removed again after the launch.
# Everything else (signatures of every Mach-O file, metadata, licences, helpers, tools) is the same.
#
# usage: scripts/ci/package-test.sh [--local] <Mergelane-x.y.z-arm64.dmg> [expected-version]
set -euo pipefail

LOCAL=${MERGELANE_PACKAGE_TEST_LOCAL:-0}
if [ "${1:-}" = "--local" ]; then
  LOCAL=1
  shift
fi
[ "$LOCAL" = 0 ] || [ "$LOCAL" = 1 ] || {
  echo "package-test: MERGELANE_PACKAGE_TEST_LOCAL must be 0 or 1" >&2
  exit 2
}
DMG=${1:?usage: package-test.sh [--local] <dmg> [expected-version]}
EXPECTED_VERSION=${2:-}
BUNDLE_ID=io.github.zahidnoor7.mergelane
# The browser bridge's socket (docs/BROWSER-BRIDGE.md); its health message reports readiness.
BRIDGE_SOCKET="$HOME/Library/Application Support/Mergelane/browser.sock"
READY_TIMEOUT_S=${READY_TIMEOUT_S:-90}

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mergelane-package-test.XXXXXX")
APP="$WORK/Applications/Mergelane.app"
MNT=""
APP_PID=""
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

cleanup() {
  if [ -n "$APP_PID" ]; then kill -KILL "$APP_PID" 2>/dev/null || true; fi
  pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
  if [ -n "$MNT" ]; then hdiutil detach -quiet "$MNT" 2>/dev/null || true; fi
  if [ "$LOCAL" = 1 ] && [ -d "$APP" ]; then unregister_copy || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "package-test: FAIL: $*" >&2
  exit 1
}
skipped() { echo "SKIPPED (local mode): $*"; }

# --- Local mode: what the launch must leave alone -------------------------------------------------

# The owner's Mergelane data and everything else that is per user and per app: if one of these
# changes during the test, the test touched the owner's Mergelane.
WATCHED=(
  "$HOME/Library/Application Support/Mergelane"
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  "$HOME/Library/Caches/Mergelane"
  "$HOME/Library/Caches/$BUNDLE_ID"
  "$HOME/Library/Logs/Mergelane"
  "$HOME/Library/Saved Application State/$BUNDLE_ID.savedState"
  "$HOME/Library/HTTPStorages/$BUNDLE_ID"
  "$HOME/Library/WebKit/$BUNDLE_ID"
)

# The app's preferences (its NSUserDefaults domain) are watched by content, read through macOS's
# preferences service (`defaults export`), not as a file. Electron writes three keys there on every
# launch (shell/browser/electron_browser_main_parts_mac.mm and browser_mac.mm), and the preferences
# service saves them under the real home whatever CFFIXED_USER_HOME says, so a launch of the copy can
# create or touch the owner's file. Those keys hold Electron's text direction and argument handling,
# the same for every launch, not the owner's data: they are left out of the comparison, and a domain
# holding only them counts as empty. Every other key is compared.
ELECTRON_LAUNCH_KEYS=(AppleTextDirection NSForceRightToLeftWritingDirection NSTreatUnknownArgumentsAsOpen)
app_preferences() {
  local copy="$WORK/preferences.plist" key
  defaults export "$BUNDLE_ID" "$copy" || return 1
  for key in "${ELECTRON_LAUNCH_KEYS[@]}"; do
    plutil -remove "$key" "$copy" >/dev/null 2>&1 || true
  done
  plutil -convert xml1 -o - "$copy" | shasum -a 256 | cut -d' ' -f1
  rm -f "$copy"
}

# LaunchServices, read-only: which app opens mergelane: and magnet: links, the handlers saved in the
# user's LaunchServices preferences, and every copy of Mergelane LaunchServices knows about.
launch_services() {
  osascript -l JavaScript - "$HOME" "$BUNDLE_ID" <<'JXA'
ObjC.import('AppKit')
function run(argv) {
  const [home, bundleId] = argv
  const ws = $.NSWorkspace.sharedWorkspace
  const opener = (scheme) => {
    const url = ws.URLForApplicationToOpenURL($.NSURL.URLWithString(scheme + '://x'))
    return url.isNil() ? null : url.path.js
  }
  const prefs = $.NSDictionary.dictionaryWithContentsOfFile(
    home + '/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist')
  const saved = {}
  const handlers = prefs.isNil() ? null : prefs.objectForKey('LSHandlers')
  if (handlers && !handlers.isNil()) {
    for (let i = 0; i < handlers.count; i++) {
      const entry = ObjC.deepUnwrap(handlers.objectAtIndex(i))
      if (entry.LSHandlerURLScheme === 'mergelane' || entry.LSHandlerURLScheme === 'magnet') {
        saved[entry.LSHandlerURLScheme] = entry.LSHandlerRoleAll ?? null
      }
    }
  }
  const copies = []
  const apps = ws.URLsForApplicationsWithBundleIdentifier(bundleId)
  for (let i = 0; i < apps.count; i++) copies.push(apps.objectAtIndex(i).path.js)
  copies.sort()
  return JSON.stringify({ opens: { mergelane: opener('mergelane'), magnet: opener('magnet') }, saved, copies })
}
JXA
}

# One line per file, folder or link under every watched path (type, size, modification time with
# nanoseconds, SHA-256), the app's preferences without Electron's launch keys, Mergelane's keychain item (attributes only: never its secret) and
# LaunchServices' state.
snapshot() {
  local path entry
  for path in "${WATCHED[@]}"; do
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      printf 'absent\t%s\n' "$path"
      continue
    fi
    while IFS= read -r -d '' entry; do
      if [ -L "$entry" ]; then
        printf 'link\t%s\t%s\n' "$(readlink "$entry")" "$entry"
      elif [ -d "$entry" ]; then
        printf 'dir\t%s\t%s\n' "$(stat -f '%Fm' "$entry")" "$entry"
      elif [ -f "$entry" ]; then
        printf 'file\t%s\t%s\t%s\t%s\n' "$(stat -f '%z' "$entry")" "$(stat -f '%Fm' "$entry")" \
          "$(shasum -a 256 <"$entry" | cut -d' ' -f1)" "$entry"
      else
        printf '%s\t%s\t%s\n' "$(stat -f '%HT' "$entry")" "$(stat -f '%Fm' "$entry")" "$entry"
      fi
    done < <(find "$path" -print0 | sort -z)
  done
  local item
  item=$(security find-generic-password -s "Mergelane Safe Storage" 2>/dev/null | grep -E '"(cdat|mdat|svce|acct)"' || true)
  local preferences
  preferences=$(app_preferences) || fail "could not read the preferences of $BUNDLE_ID"
  printf 'preferences\t%s\t(SHA-256 of %s, without Electron'"'"'s launch keys)\n' "$preferences" "$BUNDLE_ID"
  printf 'keychain\t%s\n' "${item:-no "Mergelane Safe Storage" item}" | tr '\n' ' '
  echo
  printf 'launchservices\t%s\n' "$(launch_services)"
}

# Removes the temporary copy's LaunchServices record, which launching it may have added.
unregister_copy() {
  local real
  real=$(cd "$APP" && pwd -P)
  if launch_services | grep -qF "\"$real\""; then
    "$LSREGISTER" -u "$real" && echo "removed the temporary copy's LaunchServices record ($real)"
  fi
}

if [ "$LOCAL" = 1 ]; then
  echo "package-test: local mode (docs/RELEASING.md): no quarantine flag, and an isolated launch"
  if xattr -p com.apple.quarantine "$DMG" >/dev/null 2>&1; then
    fail "$DMG carries a quarantine flag; local mode only tests DMGs built on this Mac (opening a quarantined one can bring up macOS's dialog)"
  fi
fi

step "Mount the DMG"
MNT=$(hdiutil attach -nobrowse -readonly -noautoopen "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}')
[ -d "$MNT/Mergelane.app" ] || fail "the DMG has no Mergelane.app"
[ -L "$MNT/Applications" ] || fail "the DMG has no Applications shortcut to drag the app to"

step "Copy the app out, as dragging it to Applications does"
mkdir -p "$WORK/Applications"
ditto "$MNT/Mergelane.app" "$APP"
hdiutil detach -quiet "$MNT"
MNT=""

if [ "$LOCAL" = 1 ]; then
  step "Quarantine"
  skipped "the quarantine flag is never set on this Mac, so macOS's 'could not verify' dialog can't appear"
  flagged=$(find "$APP" -xattrname com.apple.quarantine -print | head -n 5)
  [ -z "$flagged" ] || fail "the copied app carries a quarantine flag although the DMG doesn't: $flagged"
  echo "no file in the copied app carries a quarantine flag"
else
  step "Mark it quarantined, as a browser download would"
  xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$APP"
  xattr -p com.apple.quarantine "$APP"
fi

step "Signatures: the bundle verifies and every Mach-O file inside is signed"
codesign --verify --deep --strict --verbose=2 "$APP"
# Read codesign's whole report first: piped straight into `grep -q`, which stops at the match,
# codesign could be cut off writing the lines after it, and pipefail would fail a good signature.
signature=$(codesign -dv "$APP" 2>&1)
grep -q '^Signature=adhoc$' <<<"$signature" || fail "expected an ad-hoc signature"
bad=0
checked=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    checked=$((checked + 1))
    if ! codesign --verify --strict "$f" 2>/dev/null; then
      echo "not validly signed: ${f#"$APP"/}"
      bad=$((bad + 1))
    fi
  fi
done < <(find "$APP" -type f -print0)
echo "Mach-O files checked: $checked"
[ "$checked" -gt 0 ] || fail "found no Mach-O files to check"
[ "$bad" -eq 0 ] || fail "$bad Mach-O files are not validly signed"

step "Bundle metadata"
PLIST="$APP/Contents/Info.plist"
[ "$(plutil -extract CFBundleIdentifier raw "$PLIST")" = "$BUNDLE_ID" ] || fail "wrong bundle identifier"
[ "$(plutil -extract LSMinimumSystemVersion raw "$PLIST")" = "27.0" ] || fail "LSMinimumSystemVersion is not 27.0"
VERSION=$(plutil -extract CFBundleShortVersionString raw "$PLIST")
echo "version $VERSION"
if [ -n "$EXPECTED_VERSION" ] && [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  fail "version $VERSION, expected $EXPECTED_VERSION"
fi
ARCHS=$(lipo -archs "$APP/Contents/MacOS/Mergelane")
[ "$ARCHS" = "arm64" ] || fail "main executable architectures are '$ARCHS', expected arm64 only"
for f in LICENSE THIRD-PARTY-NOTICES.md; do
  [ -s "$APP/Contents/Resources/$f" ] || fail "Contents/Resources/$f is missing"
done
HELPER="$APP/Contents/Resources/mergelane-daemon"
NMHOST="$APP/Contents/Resources/mergelane-nmhost"
for bin in "$HELPER" "$NMHOST"; do
  [ -x "$bin" ] || fail "the bundled ${bin##*/} is missing"
  [ "$(lipo -archs "$bin")" = "arm64" ] || fail "the bundled ${bin##*/} is not arm64-only"
done

if [ "$LOCAL" = 1 ]; then
  step "Gatekeeper"
  skipped "spctl's assessment and syspolicy_check describe a quarantined download, and nothing here is quarantined"
  step "Install step from the README (local mode: nothing to remove), then check the bundled programs"
else
  step "Gatekeeper: rejected as unnotarised (so Open Anyway is offered), not as damaged"
  VERDICT=$(spctl --assess --type execute -vv "$APP" 2>&1 || true)
  echo "$VERDICT"
  grep -q ': rejected' <<<"$VERDICT" || fail "expected Gatekeeper to reject an unnotarised app"
  if grep -qiE 'damaged|invalid signature|sealed resource' <<<"$VERDICT"; then
    fail "Gatekeeper reports the app as damaged, which offers no Open Anyway"
  fi
  if command -v syspolicy_check >/dev/null; then
    syspolicy_check distribution "$APP" 2>&1 | grep -E '^[A-Z][A-Za-z ]+$|Severity' || true
  fi

  step "Install step from the README: remove quarantine, then open the app"
  xattr -dr com.apple.quarantine "$APP"
fi
# Inside a still-quarantined bundle macOS kills the helper (seen on macOS 27), so it is checked only
# after the documented approval, which is also when the app can run it to install it.
helper_version=$("$HELPER" version) || fail "the bundled helper does not run after approval"
[[ "$helper_version" == "mergelane-daemon $VERSION" ]] || fail "the bundled helper says '$helper_version'"
echo "bundled helper: $helper_version"
nmhost_version=$("$NMHOST" --version) || fail "the bundled browser host does not run after approval"
[[ "$nmhost_version" == "mergelane-nmhost $VERSION" ]] || fail "the bundled browser host says '$nmhost_version'"
echo "bundled browser host: $nmhost_version"
# Re-signed ad-hoc with the hardened runtime by electron-builder; they must still run.
# yt-dlp is its unpacked build, a folder (ADR-0031): every Mach-O file in it must verify after the
# re-sign (the loop above checks the whole app; this one makes sure the folder is really there).
YTDLP_DIR="$APP/Contents/Resources/yt-dlp"
[ -d "$YTDLP_DIR/_internal" ] || fail "the bundled yt-dlp folder has no _internal folder"
[ -x "$YTDLP_DIR/yt-dlp_macos" ] || fail "the bundled yt-dlp_macos is missing"
[[ " $(lipo -archs "$YTDLP_DIR/yt-dlp_macos") " == *" arm64 "* ]] || fail "the bundled yt-dlp_macos has no arm64 code"
ytdlp_machos=0
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    ytdlp_machos=$((ytdlp_machos + 1))
    codesign --verify --strict "$f" 2>/dev/null || fail "not validly signed: ${f#"$APP"/}"
  fi
done < <(find "$YTDLP_DIR" -type f -print0)
[ "$ytdlp_machos" -gt 1 ] || fail "found $ytdlp_machos Mach-O files in the yt-dlp folder, expected its program and libraries"
echo "yt-dlp folder: $ytdlp_machos Mach-O files, all validly signed"
ytdlp_version=$("$YTDLP_DIR/yt-dlp_macos" --version) || fail "the bundled yt-dlp does not run"
echo "bundled yt-dlp: $ytdlp_version"
# FFmpeg is Mergelane's own build from FFmpeg's source (ADR-0028): LGPL 2.1 or later, nothing that
# would make it GPL or nonfree, arm64, and it runs. (Outputs are read whole before grep, so grep -q
# can't cut a pipe short under pipefail.)
FFMPEG="$APP/Contents/Resources/ffmpeg"
[ "$(lipo -archs "$FFMPEG")" = "arm64" ] || fail "the bundled ffmpeg is not arm64-only"
ffmpeg_version=$("$FFMPEG" -hide_banner -version) || fail "the bundled ffmpeg does not run"
ffmpeg_license=$("$FFMPEG" -hide_banner -L) || fail "the bundled ffmpeg does not show its licence"
grep -q 'GNU Lesser General Public' <<<"$ffmpeg_license" || fail "the bundled ffmpeg does not report the LGPL"
grep -q 'version 2.1 of the License' <<<"$ffmpeg_license" || fail "the bundled ffmpeg does not report LGPL version 2.1"
ffmpeg_buildconf=$("$FFMPEG" -hide_banner -buildconf) || fail "the bundled ffmpeg does not show its configuration"
if grep -qE -- '--enable-(gpl|version3|nonfree)' <<<"$ffmpeg_buildconf"; then
  fail "the bundled ffmpeg was configured with --enable-gpl, --enable-version3 or --enable-nonfree"
fi
echo "bundled ffmpeg: ${ffmpeg_version%%$'\n'*}"
for f in licenses/ffmpeg/LICENSE.md licenses/ffmpeg/COPYING.LGPLv2.1 licenses/yt-dlp/GPL-3.0.txt \
  licenses/yt-dlp/LICENSE licenses/yt-dlp/THIRD_PARTY_LICENSES.txt; do
  [ -s "$APP/Contents/Resources/$f" ] || fail "$f is missing from the bundle"
done
[ ! -e "$APP/Contents/Resources/licenses/ffmpeg/COPYING.GPLv3" ] ||
  fail "licenses/ffmpeg/COPYING.GPLv3 (from the old GPL build) is still in the bundle"
# Deno, which yt-dlp runs YouTube's player challenges in (ADR-0026): arm64 only, and it must still
# run, with JIT, once re-signed with the hardened runtime.
DENO="$APP/Contents/Resources/deno"
[ -x "$DENO" ] || fail "the bundled deno is missing"
[ "$(lipo -archs "$DENO")" = "arm64" ] || fail "the bundled deno is not arm64-only"
deno_version=$(DENO_NO_UPDATE_CHECK=1 DENO_DIR="$WORK/deno" "$DENO" --version | head -n 1) ||
  fail "the bundled deno does not run"
echo "bundled deno: $deno_version"
deno_sum=$(printf 'console.log(1 + 2)' |
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$WORK/deno" "$DENO" run --ext=js --no-prompt --no-remote --no-config -) ||
  fail "the bundled deno cannot run JavaScript"
[ "$deno_sum" = "3" ] || fail "the bundled deno printed '$deno_sum' for 1 + 2"
[ -s "$APP/Contents/Resources/licenses/deno/LICENSE.md" ] || fail "licenses/deno/LICENSE.md is missing from the bundle"
[ -s "$APP/Contents/Resources/licenses/deno/THIRD-PARTY-NOTICES.txt" ] ||
  fail "licenses/deno/THIRD-PARTY-NOTICES.txt (what is built into Deno) is missing from the bundle"
if [ "$LOCAL" = 1 ]; then
  step "Local mode: record what the launch must leave alone"
  FAKE_HOME="$WORK/h"
  USER_DATA="$WORK/u"
  BRIDGE_SOCKET="$USER_DATA/browser.sock"
  # macOS caps a socket path at 104 bytes, the terminating zero included.
  [ "${#BRIDGE_SOCKET}" -lt 104 ] || fail "the socket path $BRIDGE_SOCKET is too long for macOS; set TMPDIR shorter"
  mkdir -p "$FAKE_HOME"
  BEFORE="$WORK/before.txt"
  snapshot >"$BEFORE"
  echo "recorded $(wc -l <"$BEFORE" | tr -d ' ') entries"
  grep -E '^(absent|preferences|keychain|launchservices)' "$BEFORE" | sed "s|$HOME|~|g"
  # The app tells macOS it opens mergelane: links (setAsDefaultProtocolClient, by bundle ID). That
  # only leaves the owner's preferences as they were when they already name Mergelane.
  saved_handler=$(sed -n 's/^launchservices\t//p' "$BEFORE" |
    plutil -extract saved.mergelane raw -o - - 2>/dev/null || true)
  if [ "$saved_handler" != "$BUNDLE_ID" ]; then
    skipped "launch: macOS doesn't have Mergelane saved as the handler of mergelane: links yet, and launching would save it; install and open Mergelane once, then run this again"
    echo
    echo "package-test: PASS without the launch ($DMG)"
    exit 0
  fi
  if pgrep -f "^/Applications/Mergelane.app/Contents/MacOS/Mergelane" >/dev/null; then
    echo "/Applications/Mergelane.app is running; the test copy has its own data folder, so its single-instance lock can't hand over to it"
  fi

  step "Open the copy directly, with its own home and data folders"
  env -u ELECTRON_RUN_AS_NODE HOME="$FAKE_HOME" CFFIXED_USER_HOME="$FAKE_HOME" \
    "$APP/Contents/MacOS/Mergelane" --user-data-dir="$USER_DATA" --use-mock-keychain \
    >"$WORK/app.log" 2>&1 &
  APP_PID=$!
  echo "started pid $APP_PID"
else
  open -n "$APP"
fi

step "Wait for the bridge socket's health message to report ready (up to ${READY_TIMEOUT_S}s)"
deadline=$((SECONDS + READY_TIMEOUT_S))
health=""
while [ $SECONDS -lt $deadline ]; do
  if [ -n "$APP_PID" ] && ! kill -0 "$APP_PID" 2>/dev/null; then
    tail -n 20 "$WORK/app.log" >&2 || true
    fail "the app exited before it was ready"
  fi
  body=$(printf '{"v":2,"origin":"","message":{"type":"health"}}\n' | nc -U -w 3 "$BRIDGE_SOCKET" 2>/dev/null || true)
  if grep -q '"app":"mergelane"' <<<"$body" && grep -q '"ready":true' <<<"$body"; then
    health=$body
    break
  fi
  sleep 1
done
[ -n "$health" ] || fail "the app did not report ready within ${READY_TIMEOUT_S}s"
echo "ready: $health"
[ "$(stat -f %Lp "$BRIDGE_SOCKET")" = "600" ] || fail "the bridge socket is not private (mode 0600)"
grep -q "\"version\":\"$VERSION\"" <<<"$health" || fail "the running app reports a different version"

step "Quit"
if [ "$LOCAL" = 1 ]; then
  # By its process ID: "tell application id" could pick the owner's Mergelane. Electron quits
  # cleanly on SIGTERM.
  kill -TERM "$APP_PID"
else
  osascript -e "with timeout of 20 seconds" -e "tell application id \"$BUNDLE_ID\" to quit" -e "end timeout" ||
    pkill -f "$APP/Contents/MacOS/" || true
fi
for _ in $(seq 1 40); do
  pgrep -f "$APP/Contents/MacOS/Mergelane" >/dev/null || break
  sleep 0.5
done
if pgrep -f "$APP/Contents/MacOS/Mergelane" >/dev/null; then fail "the app did not quit"; fi
APP_PID=""

if [ "$LOCAL" = 1 ]; then
  step "Local mode: the owner's Mergelane was left alone"
  unregister_copy
  echo "what the copy wrote, all inside the test folder:"
  (cd "$WORK" && find h u -maxdepth 3 | sort | head -n 40)
  for browser in "Google/Chrome" "Google/ChromeForTesting" "Chromium" "Mozilla"; do
    [ ! -e "$FAKE_HOME/Library/Application Support/$browser" ] ||
      fail "the copy found a $browser folder in its own home, which should be empty"
  done
  AFTER="$WORK/after.txt"
  snapshot >"$AFTER"
  if ! diff -u "$BEFORE" "$AFTER" >"$WORK/changes.diff"; then
    sed "s|$HOME|~|g" "$WORK/changes.diff" >&2
    if pgrep -f "^/Applications/Mergelane.app/Contents/MacOS/Mergelane" >/dev/null; then
      echo "(/Applications/Mergelane.app is running and may have written these itself: quit it and run again to tell)" >&2
    fi
    fail "something of the owner's Mergelane changed during the test (above)"
  fi
  echo "unchanged: $(grep -c . "$AFTER") entries (files with their SHA-256 and times, the app's preferences, the keychain item, LaunchServices)"
fi

echo
echo "package-test: PASS ($DMG)"
