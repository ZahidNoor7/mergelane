#!/usr/bin/env bash
# Tests for local-root.sh without root: argument handling, and dry runs against a fake Mac (stub
# launchctl, netstat, scutil, ifconfig, pgrep, ps and dnctl, and a fake helper binary). A stub sudo
# fails the test if a dry run ever calls it. Real refusal logic runs (scripts/ci/local-root-lib.mjs).
# usage: bash scripts/ci/local-root.test.sh
#
# shellcheck disable=SC2016 # stub bodies are literal scripts, expanded when the stub runs
# shellcheck disable=SC2015 # ok() always returns 0, so "check && ok || bad" never fails an ok
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RUNNER="$HERE/local-root.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
passed=0
failed=0

mkdir -p "$T/bin" "$T/logs" "$T/lib-daemons" "$T/lib-tools"
stub() { # <name> <body>
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG"\n%s\n' "$1" "$2" >"$T/bin/$1"
  chmod +x "$T/bin/$1"
}
stub sudo 'echo "SUDO CALLED: $*" >>"$STUB_LOG"; exit 1'
stub launchctl '
case "$1" in
  print) [ "${STUB_LOADED:-yes}" = yes ] && { echo "system/x = { state = running }"; exit 0; }; exit 113 ;;
  print-disabled) printf "disabled services = {\n\t\"io.github.zahidnoor7.mergelane.daemon\" => enabled\n}\n" ;;
esac
exit 0'
stub netstat 'cat "$STUB_ROUTES"'
stub scutil 'echo "Available network connection services in the current set (*=enabled):"; printf "%b" "${STUB_SCUTIL:-}"'
stub ifconfig '
case "${1:-}" in
  -a | lo0) printf "lo0: flags=8049<UP,LOOPBACK>\n\tinet 127.0.0.1 netmask 0xff000000\nen0: flags=8863<UP>\n\tinet 192.168.1.7 netmask 0xffffff00\n" ;;
  -l) echo "lo0 en0 ${STUB_IFACES:-}" ;;
  *) for i in ${STUB_IFACES:-}; do [ "$i" = "$1" ] && { echo "$1: flags=8863<UP>"; exit 0; }; done; exit 1 ;;
esac'
# STUB_PROCS: one "pid command line" per line, the other processes on the fake Mac.
stub pgrep '
pat=${*: -1}
while read -r pid cmd; do
  [ -n "$pid" ] && grep -qE -- "$pat" <<<"$cmd" && { if [ "$1" = -fl ]; then echo "$pid $cmd"; else echo "$pid"; fi; }
done <<<"${STUB_PROCS:-}"
exit 0'
# ps -o pgid= -p <pid>: the fake Mac's other processes are in group 99999, the runner's own in 1.
stub ps 'while read -r pid _; do [ -n "$pid" ] && [ "$pid" = "${4:-}" ] && { echo 99999; exit 0; }; done <<<"${STUB_PROCS:-}"; echo 1'
stub dnctl 'exit 0'
stub pfctl 'exit 0'

# The fake helper answers like mergelane-daemon 0.1.0 does.
cat >"$T/helper" <<'EOF'
#!/usr/bin/env bash
[ -n "${STUB_HELPER_DOWN:-}" ] && { echo "error: mergelane-daemon isn't running" >&2; exit 1; }
case "$1" in
  status) echo "system merge: ${STUB_MERGE:-on} (daemon 0.1.0, protocol 1)" ;;
  links) echo "en0      index 14  up       up=true  v4 192.168.1.7" ;;
esac
EOF
chmod +x "$T/helper"
echo '<plist/>' >"$T/plist"

MERGING="$T/routes-merging"
cat >"$MERGING" <<'EOF'
Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                utun7              US2cg               utun7
default            192.168.1.1        UGScg                 en0
128.0/1            utun7              US2c                utun7
EOF
VPN="$T/routes-vpn"
cat >"$VPN" <<'EOF'
Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
0/1                10.8.0.1           UGSc                utun4
default            192.168.1.1        UGScg                 en0
128.0/1            10.8.0.1           UGSc                utun4
EOF

# runner <args...>: local-root.sh against the fake Mac. Sets OUT and RC.
runner() {
  : >"$T/calls"
  OUT=$(env PATH="$T/bin:$PATH" STUB_LOG="$T/calls" STUB_ROUTES="${STUB_ROUTES:-$MERGING}" \
    LOCAL_ROOT_LOG_DIR="$T/logs" LOCAL_ROOT_PLIST="${FAKE_PLIST-$T/plist}" LOCAL_ROOT_HELPER="${FAKE_HELPER-$T/helper}" \
    LOCAL_ROOT_SUPPORT="$T/support" LOCAL_ROOT_BACKUP="$T/backup" \
    bash "$RUNNER" "$@" </dev/null 2>&1)
  RC=$?
}
ok() {
  echo "ok   $1"
  passed=$((passed + 1))
}
bad() {
  echo "FAIL $1"$'\n'"${2:-}" | head -60
  failed=$((failed + 1))
}
# expect <name> <want exit> [text the output must contain]...
expect() {
  local name=$1 want=$2 text
  shift 2
  if [ "$RC" -ne "$want" ]; then
    bad "$name: exit $RC, want $want" "$OUT"
    return
  fi
  for text in "$@"; do
    grep -qF -- "$text" <<<"$OUT" || {
      bad "$name: output lacks '$text'" "$OUT"
      return
    }
  done
  if grep -q 'SUDO CALLED' "$T/calls"; then
    bad "$name: sudo was called" "$(grep 'SUDO CALLED' "$T/calls")"
    return
  fi
  ok "$name"
}
lacks() {
  if grep -qF -- "$2" <<<"$OUT"; then bad "$1: output has '$2'" "$OUT"; else ok "$1"; fi
}
reset() {
  unset STUB_ROUTES STUB_SCUTIL STUB_IFACES STUB_PROCS STUB_LOADED STUB_MERGE STUB_HELPER_DOWN FAKE_PLIST FAKE_HELPER
  rm -rf "$T/backup" "$T/support"
}

# --- arguments -------------------------------------------------------------------------------
reset
runner --help
expect "--help prints the usage" 0 "usage: scripts/ci/local-root.sh" "--restore"
runner --frobnicate
expect "an unknown argument is refused" 2 "unknown argument '--frobnicate'"
runner --only netsim,cloud --dry-run
expect "--only rejects an unknown suite" 2 "--only takes go, netsim, daemon and app, got 'cloud'"
runner --only , --dry-run
expect "--only needs a suite" 2 "--only needs at least one suite"

# --- a clean Mac, helper merging ---------------------------------------------------------------
reset
runner --dry-run
expect "a dry run on a clean Mac passes its checks and prints the plan" 0 \
  "all checks passed" \
  "YOUR INTERNET STOPS WORKING" \
  "[root] mkdir -m 700 $T/backup" \
  "[root] cp -p $T/plist $T/backup/plist" \
  "[root] cp -p $T/helper $T/backup/binary" \
  "[you]  $T/helper off" \
  "[root] launchctl bootout system/io.github.zahidnoor7.mergelane.daemon" \
  "+ ifconfig feth10 create" \
  "+ ifconfig feth20 down" \
  "sudo bash" \
  "[root] launchctl bootstrap system $T/plist" \
  "[you]  $T/helper on"
lacks "a dry run never flushes pf globally" "-F all"
lacks "a dry run never runs dnctl flush" "dnctl -q flush"
grep -q 'merge=on' <<<"$OUT" && ok "it reads the helper's state through its socket" || bad "no merge state" "$OUT"
log=$(find "$T/logs" -name 'root-*.log' | tail -1)
[ -n "$log" ] && grep -qF "all checks passed" "$log" && ok "everything goes to local-ci-logs/root-<time>.log" || bad "no log file" "$(ls -la "$T/logs")"
[ ! -e "$T/backup" ] && ok "a dry run creates no backup" || bad "backup created"
grep -q '^launchctl print ' "$T/calls" && ok "it asks launchd whether the helper is loaded" || bad "no launchctl print" "$(cat "$T/calls")"
grep -qE '^(launchctl (bootout|bootstrap|enable|disable)|dnctl pipe [0-9]|pfctl .*-(f|F|E|X))' "$T/calls" &&
  bad "a dry run ran a command that changes the system" "$(cat "$T/calls")" || ok "a dry run changes nothing"

runner --dry-run --only go
expect "--only go adds the two lo0 aliases and removes them" 0 "Suites: go." \
  "[root] ifconfig lo0 alias 127.0.0.2/32" "[root] ifconfig lo0 -alias 127.0.0.3"
runner --dry-run --only daemon
expect "--only daemon plans only that suite" 0 "Suite daemon" "Suites: daemon."
lacks "... not the app suite" "Suite app"
lacks "... not the netsim suite" "Suite netsim"

# --- refusals ----------------------------------------------------------------------------------
reset
STUB_ROUTES=$VPN
runner --dry-run
expect "an active VPN (unscoped /1 routes on another utun) is refused" 2 \
  "NOT STARTING. Nothing was changed." "a VPN is active: VPN route 0/1 on utun4" "A real run would NOT start now"
reset
export STUB_SCUTIL='* (Connected)      ABCD VPN (IKEv2) "Work" [VPN/IKEv2]\n'
runner --dry-run
expect "a connected scutil VPN service is refused" 2 'a VPN is active: VPN service: * (Connected)'
reset
export STUB_PROCS="47401 /Applications/Mergelane.app/Contents/MacOS/Mergelane"
runner --dry-run
expect "a running Mergelane.app is refused" 2 "Mergelane.app is running: quit it first"
reset
export STUB_PROCS="2213 node /Users/x/.npm/_npx/abc/node_modules/.bin/playwright-mcp"
runner --dry-run
expect "an editor's Playwright MCP server is not a test run" 0 "all checks passed"
reset
export STUB_PROCS="5555 node /Users/x/mergelane/app/node_modules/.bin/playwright test --grep @smoke"
runner --dry-run
expect "a Playwright test run is refused" 2 "a Playwright test run is active"
reset
export STUB_PROCS="6666 bash scripts/acceptance/daemon.sh"
runner --dry-run
expect "another root test run is refused" 2 "another Mergelane root test run is active"
reset
export STUB_PROCS="7777 /tmp/mergelane-acceptance-bin/mergelane-daemon run --include feth10"
runner --dry-run
expect "a running acceptance daemon is refused" 2 "a Mergelane acceptance daemon is running"
reset
mkdir -p "$T/backup"
runner --dry-run
expect "a backup left by an earlier run is refused" 2 "an earlier run's helper backup is still at $T/backup" "--restore' first"
reset
export STUB_IFACES="feth20"
runner --dry-run
expect "an existing feth20 is refused" 2 "interface feth20 exists"
reset
export STUB_HELPER_DOWN=1
runner --dry-run
expect "a loaded helper that does not answer is refused" 2 "does not answer on its socket"

# --- other helper states -----------------------------------------------------------------------
reset
export STUB_LOADED=no
FAKE_PLIST="$T/no-plist" FAKE_HELPER="$T/no-helper" runner --dry-run
expect "no helper installed: nothing to pause, nothing to restore" 0 "the helper is not installed" "it was not installed"
pause=$(sed -n "/Pausing Mergelane's helper/,/^===/p" <<<"$OUT")
grep -q 'launchctl bootout' <<<"$pause" && bad "... the pause boots something out" "$pause" || ok "... no bootout when pausing"
lacks "... no merging off" "[you]  $T/no-helper off"
reset
export STUB_MERGE=off
runner --dry-run
expect "a helper merging off is paused but not turned on again" 0 "merging is off now" "[root] launchctl bootstrap system $T/plist"
lacks "... no 'on' at the end" "[you]  $T/helper on"

# --- --restore ---------------------------------------------------------------------------------
reset
runner --restore --dry-run
expect "--restore --dry-run prints the whole undo" 0 \
  "DRY RUN of --restore" \
  "[root] pkill -f ^/tmp/mergelane-acceptance-bin/" \
  "down --sweep, which here would run:" \
  "[root] rm -rf /var/run/mergelane-acceptance" \
  "Restoring Mergelane's helper"

echo
echo "local-root.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
