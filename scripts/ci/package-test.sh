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
