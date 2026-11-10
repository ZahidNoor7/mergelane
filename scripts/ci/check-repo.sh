#!/usr/bin/env bash
# Repository policy checks: the parts of CLAUDE.md's hard constraints that can be checked statically.
#
# usage: scripts/ci/check-repo.sh [repo-root]
# Exits 0 when every check passes, 1 otherwise. Each failure is printed on its own line.
set -uo pipefail

ROOT=${1:-$(git rev-parse --show-toplevel)}
failed=0
fail() {
  echo "check-repo: $*" >&2
  failed=1
}

# 1. Required project files.
for f in LICENSE THIRD-PARTY-NOTICES.md README.md CHANGELOG.md CLAUDE.md \
  docs/PHASE-1.md docs/PROGRESS.md docs/DECISIONS.md docs/UPSTREAM.md; do
  [ -f "$ROOT/$f" ] || fail "missing required file: $f"
done

# 2. Upstream MIT copyright notices must be kept.
for notice in "Copyright (c) 2026 Anmol Kapil" \
  "Copyright (c) 2026 Rohit Mahto" \
  "Copyright (c) 2026 Awesome Downloader contributors"; do
  for f in LICENSE THIRD-PARTY-NOTICES.md; do
    [ -f "$ROOT/$f" ] && ! grep -qF "$notice" "$ROOT/$f" && fail "$f is missing upstream notice: $notice"
  done
done

TRACKED=$(git -C "$ROOT" ls-files)

# 3. FFmpeg, yt-dlp and Deno ship as separate executables fetched (or, for FFmpeg, built) at build
#    time; they are never committed. That covers yt-dlp's unpacked build, a folder with its program
#    and an _internal folder of libraries and data (ADR-0031), and anything in fetch.mjs's output
#    folder, app/resources/bin.
bundled=$(printf '%s\n' "$TRACKED" |
  grep -E '(^|/)(ffmpeg|ffprobe|yt-dlp|yt-dlp_macos|deno)(\.exe)?$|(^|/)yt-dlp/_internal/|^app/resources/bin/' || true)
[ -n "$bundled" ] && fail "third-party executable committed (fetch it at build time instead): $bundled"

# 4. No compiled binaries in the repository.
while IFS= read -r f; do
  [ -f "$ROOT/$f" ] || continue
  # Universal (fat) Mach-O files print one line per architecture, so match any line.
  if file -b --mime-type "$ROOT/$f" |
    grep -qE 'application/(x-mach-binary|x-executable|x-sharedlib|x-dosexec|vnd\.microsoft\.portable-executable)'; then
    fail "compiled binary committed: $f"
  fi
done <<<"$TRACKED"

# 5. Secrets and signing material must never be committed.
secrets=$(printf '%s\n' "$TRACKED" | grep -E '(^|/)\.env(\..+)?$|\.(p12|p8|cer|pem|key)$' |
  grep -vE '(^|/)\.env\.example$' || true)
[ -n "$secrets" ] && fail "secret or signing file committed: $secrets"

# 6. No third-party trademarks in product names or user-facing text.
for p in README.md app/src app/electron-builder.yml extension/src extension/manifest.json; do
  [ -e "$ROOT/$p" ] || continue
  hits=$(grep -rnwE 'IDM|Internet Download Manager' "$ROOT/$p" 2>/dev/null || true)
  [ -n "$hits" ] && fail "trademark in user-facing text: $hits"
done

if [ "$failed" -eq 0 ]; then
  echo "check-repo: all checks passed"
fi
exit "$failed"
