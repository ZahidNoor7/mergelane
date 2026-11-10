#!/usr/bin/env bash
# Spike S1: how does Gatekeeper treat a quarantined, ad-hoc-signed app copied out of a DMG?
set -u
WORK=${RUNNER_TEMP:-$(mktemp -d)}/s1-gatekeeper
rm -rf "$WORK" && mkdir -p "$WORK/src" "$WORK/Applications"
MARK=/private/tmp/mergelane-s1-gk
rm -f "$MARK".*

APP="$WORK/src/S1Hello.app"
mkdir -p "$APP/Contents/MacOS"
cat >"$WORK/hello.c" <<'EOF'
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *tag = argc > 1 ? argv[1] : "open";
  char path[256];
  snprintf(path, sizeof path, "/private/tmp/mergelane-s1-gk.%s", tag);
  FILE *f = fopen(path, "w");
  if (f) { fprintf(f, "ran pid=%d\n", getpid()); fclose(f); }
  return 0;
}
EOF
clang -arch arm64 -O2 -o "$APP/Contents/MacOS/s1hello" "$WORK/hello.c"
cat >"$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>s1hello</string>
  <key>CFBundleIdentifier</key><string>io.github.zahidnoor7.s1hello</string>
  <key>CFBundleName</key><string>S1Hello</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>27.0</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
EOF
codesign --force --deep --sign - "$APP"
echo "=== codesign verify (ad-hoc)"
codesign --verify --deep --strict --verbose=2 "$APP"; echo "exit $?"
codesign -dvv "$APP" 2>&1 | grep -E 'Signature|Identifier|flags' || true

echo "=== build DMG, mount, copy out"
hdiutil create -quiet -volname S1Hello -srcfolder "$WORK/src" -ov -format UDZO "$WORK/S1Hello.dmg"
MNT=$(hdiutil attach -nobrowse -readonly "$WORK/S1Hello.dmg" | awk -F'\t' '/Volumes/{print $NF}')
ditto "$MNT/S1Hello.app" "$WORK/Applications/S1Hello.app"
hdiutil detach -quiet "$MNT"
COPY="$WORK/Applications/S1Hello.app"

echo "=== add quarantine like a browser download"
QV="0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)"
xattr -w com.apple.quarantine "$QV" "$COPY"
xattr -w com.apple.quarantine "$QV" "$COPY/Contents/MacOS/s1hello"
xattr -l "$COPY"

echo "=== spctl --status"
spctl --status 2>&1
echo "=== spctl --assess (quarantined)"
spctl --assess --type execute -vv "$COPY" 2>&1; echo "exit $?"
echo "=== syspolicy_check distribution (if present)"
command -v syspolicy_check >/dev/null && syspolicy_check distribution "$COPY" 2>&1 | head -20

echo "=== launch quarantined via open"
open -n "$COPY" --args open 2>&1; echo "open exit $?"
sleep 5
echo "=== launch quarantined by direct exec"
"$COPY/Contents/MacOS/s1hello" exec 2>&1; echo "exec exit $?"
ls -l "$MARK".* 2>/dev/null || echo "no markers yet"
log show --last 2m --style compact --predicate 'process == "syspolicyd" OR subsystem == "com.apple.syspolicy"' 2>/dev/null | grep -i s1hello | tail -10

echo "=== remove quarantine (documented install step) and launch via open"
xattr -dr com.apple.quarantine "$COPY"
open -n "$COPY" --args afterxattr 2>&1; echo "open exit $?"
sleep 5
ls -l "$MARK".* 2>/dev/null
for f in "$MARK".*; do [ -f "$f" ] && echo "$f: $(cat "$f")"; done
exit 0
