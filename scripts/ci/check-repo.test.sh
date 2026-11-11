#!/usr/bin/env bash
# Tests for check-repo.sh: a clean fixture passes, and each kind of violation is reported.
# usage: scripts/ci/check-repo.test.sh
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CHECK="$HERE/check-repo.sh"
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
passed=0
failed=0

make_fixture() {
  local dir=$1
  rm -rf "$dir" && mkdir -p "$dir/docs"
  for f in README.md CHANGELOG.md CLAUDE.md docs/PHASE-1.md docs/PROGRESS.md docs/DECISIONS.md docs/UPSTREAM.md; do
    echo "# fixture" >"$dir/$f"
  done
  for f in LICENSE THIRD-PARTY-NOTICES.md; do
    printf '%s\n' "Copyright (c) 2026 Mergelane contributors" \
      "Copyright (c) 2026 Anmol Kapil" \
      "Copyright (c) 2026 Rohit Mahto" \
      "Copyright (c) 2026 Awesome Downloader contributors" >"$dir/$f"
  done
  git -C "$dir" init -q
  git -C "$dir" add -A
}

# expect <name> <want-exit> <want-message-or-empty> <fixture-dir>
expect() {
  local name=$1 want=$2 msg=$3 dir=$4 out rc
  out=$(bash "$CHECK" "$dir" 2>&1)
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    echo "FAIL $name: exit $rc, want $want"$'\n'"$out"
    failed=$((failed + 1))
  elif [ -n "$msg" ] && ! grep -qF "$msg" <<<"$out"; then
    echo "FAIL $name: output lacks '$msg'"$'\n'"$out"
    failed=$((failed + 1))
  else
    echo "ok   $name"
    passed=$((passed + 1))
  fi
}

F="$SCRATCH/repo"

make_fixture "$F"
expect "clean fixture passes" 0 "all checks passed" "$F"

make_fixture "$F"
git -C "$F" rm -q --cached docs/DECISIONS.md && rm "$F/docs/DECISIONS.md"
expect "missing required file" 1 "missing required file: docs/DECISIONS.md" "$F"

make_fixture "$F"
grep -v "Rohit Mahto" "$F/LICENSE" >"$F/LICENSE.tmp" && mv "$F/LICENSE.tmp" "$F/LICENSE"
expect "missing upstream notice" 1 "LICENSE is missing upstream notice: Copyright (c) 2026 Rohit Mahto" "$F"

make_fixture "$F"
mkdir -p "$F/app/resources/bin" && echo "not really ffmpeg" >"$F/app/resources/bin/ffmpeg" && git -C "$F" add -A
expect "committed ffmpeg" 1 "third-party executable committed" "$F"

make_fixture "$F"
mkdir -p "$F/vendor" && echo "x" >"$F/vendor/yt-dlp.exe" && git -C "$F" add -A
expect "committed yt-dlp.exe" 1 "third-party executable committed" "$F"

make_fixture "$F"
cp /usr/bin/true "$F/helper" && git -C "$F" add -A
expect "committed universal Mach-O binary" 1 "compiled binary committed: helper" "$F"

make_fixture "$F"
printf 'int main(void){return 0;}\n' >"$SCRATCH/thin.c"
clang -arch arm64 -o "$F/thin" "$SCRATCH/thin.c" && git -C "$F" add -A
expect "committed arm64 Mach-O binary" 1 "compiled binary committed: thin" "$F"

make_fixture "$F"
echo "TOKEN=x" >"$F/.env" && git -C "$F" add -f .env
expect "committed .env" 1 "secret or signing file committed: .env" "$F"

make_fixture "$F"
echo "TOKEN=" >"$F/.env.example" && git -C "$F" add -f .env.example
expect ".env.example is allowed" 0 "all checks passed" "$F"

make_fixture "$F"
echo "x" >"$F/AuthKey_ABC.p8" && git -C "$F" add -f AuthKey_ABC.p8
expect "committed .p8 key" 1 "secret or signing file committed: AuthKey_ABC.p8" "$F"

make_fixture "$F"
echo "The best IDM alternative" >>"$F/README.md" && git -C "$F" add -A
expect "trademark in README" 1 "trademark in user-facing text" "$F"

make_fixture "$F"
mkdir -p "$F/extension/src" && echo "const name = 'Internet Download Manager'" >"$F/extension/src/a.ts" && git -C "$F" add -A
expect "trademark in extension source" 1 "trademark in user-facing text" "$F"

make_fixture "$F"
echo "IDMs and other download managers" >>"$F/README.md" && git -C "$F" add -A
expect "word-boundary: IDMs is not flagged" 0 "all checks passed" "$F"

echo "check-repo tests: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
