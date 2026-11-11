#!/usr/bin/env bash
# Packaging test (Phase 1 acceptance criterion 1, docs/DECISIONS.md ADR-0013).
#
# Installs the DMG the way a user does and checks that the app reaches its ready state:
#   mount -> copy the app out -> mark it quarantined -> verify every signature and the bundle
#   metadata -> check Gatekeeper's verdict is "unnotarised" (Open Anyway), not "damaged" ->
#   remove quarantine (the README's install step) -> open -> ask the bridge socket's health until ready -> quit.
#
# usage: scripts/ci/package-test.sh <Mergelane-x.y.z-arm64.dmg> [expected-version]
set -euo pipefail

DMG=${1:?usage: package-test.sh <dmg> [expected-version]}
EXPECTED_VERSION=${2:-}
BUNDLE_ID=io.github.zahidnoor7.mergelane
# The browser bridge's socket (docs/BROWSER-BRIDGE.md); its health message reports readiness.
BRIDGE_SOCKET="$HOME/Library/Application Support/Mergelane/browser.sock"
READY_TIMEOUT_S=${READY_TIMEOUT_S:-90}

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mergelane-package-test.XXXXXX")
APP="$WORK/Applications/Mergelane.app"
MNT=""

cleanup() {
  pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
  if [ -n "$MNT" ]; then hdiutil detach -quiet "$MNT" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "package-test: FAIL: $*" >&2
  exit 1
}

step "Mount the DMG"
MNT=$(hdiutil attach -nobrowse -readonly -noautoopen "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}')
[ -d "$MNT/Mergelane.app" ] || fail "the DMG has no Mergelane.app"
[ -L "$MNT/Applications" ] || fail "the DMG has no Applications shortcut to drag the app to"

step "Copy the app out, as dragging it to Applications does"
mkdir -p "$WORK/Applications"
ditto "$MNT/Mergelane.app" "$APP"
hdiutil detach -quiet "$MNT"
MNT=""

step "Mark it quarantined, as a browser download would"
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$APP"
xattr -p com.apple.quarantine "$APP"

step "Signatures: the bundle verifies and every Mach-O file inside is signed"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -q '^Signature=adhoc$' || fail "expected an ad-hoc signature"
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
open -n "$APP"

step "Wait for the bridge socket's health message to report ready (up to ${READY_TIMEOUT_S}s)"
deadline=$((SECONDS + READY_TIMEOUT_S))
health=""
while [ $SECONDS -lt $deadline ]; do
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
osascript -e "with timeout of 20 seconds" -e "tell application id \"$BUNDLE_ID\" to quit" -e "end timeout" ||
  pkill -f "$APP/Contents/MacOS/" || true
for _ in $(seq 1 20); do
  pgrep -f "$APP/Contents/MacOS/Mergelane" >/dev/null || break
  sleep 0.5
done
if pgrep -f "$APP/Contents/MacOS/Mergelane" >/dev/null; then fail "the app did not quit"; fi

echo
echo "package-test: PASS ($DMG)"
