#!/usr/bin/env bash
# Runs a command inside a fresh simulated network (netsim.sh), always tears it down (on Ctrl-C too),
# and fails if the Mac's network state afterwards differs from before: IPv4 and IPv6 routes,
# interfaces, pf anchors (netsim's own one included) and dummynet pipes. Run as a normal user with
# sudo: CI runners have passwordless sudo; on a Mac use scripts/ci/local-root.sh, which pauses the
# installed Mergelane helper first and keeps sudo's timestamp fresh.
#
# usage: scripts/netsim/with-netsim.sh "<id>:<Mbit/s>:<delay ms>:<loss> ..." -- <command> [args...]
# The command sees NETSIM_SERVER=198.51.100.10, NETSIM_CONTROL=http://127.0.0.1:8090, NETSIM_LINKS
# (e.g. "1 2"), and NETSIM_SERVER6=2001:db8:198:51:100::10 when the links carry IPv6 (otherwise
# NETSIM_V6_ERROR says why not). The test server runs for the whole command.
#
# NETSIM_SNAPSHOT_IGNORE, if set, is an extended regex of snapshot lines left out of the comparison:
# state macOS changes by itself on a personal Mac (local-root.sh passes IPv6 link-local entries of
# system interfaces). Ignored lines that changed are still printed. CI leaves it unset.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
HELPER=/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon
NETSIM_STATE=/var/run/mergelane-netsim
SPECS=${1:?usage: with-netsim.sh "<specs>" -- <command...>}
shift
[ "${1:-}" = "--" ] && shift
[ $# -ge 1 ] || {
  echo "with-netsim: no command given" >&2
  exit 2
}
read -r -a SPEC_LIST <<<"$SPECS"

if pgrep -f "^$HELPER run" >/dev/null 2>&1; then
  echo "with-netsim: the installed Mergelane helper is running and would pick up the simulated links." \
    "Pause it first: scripts/ci/local-root.sh does that, and restores it afterwards." >&2
  exit 2
fi
if [ -e "$NETSIM_STATE/links" ]; then
  echo "with-netsim: netsim is already up (another run, or one that did not finish:" \
    "'sudo bash scripts/netsim/netsim.sh down' removes it)" >&2
  exit 2
fi

snapshot() {
  # Cloned and link-layer entries (W flag) come and go on their own; everything else must match.
  netstat -rn -f inet | awk 'NR>3 && $3 !~ /W/'
  netstat -rn -f inet6 | awk 'NR>3 && $3 !~ /W/'
  ifconfig -l | tr ' ' '\n' | sort
  sudo pfctl -s Anchors 2>/dev/null | sort
  # netsim's anchor sits below com.apple, where macOS adds and removes its own anchors too.
  sudo pfctl -a com.apple -s Anchors 2>/dev/null | grep mergelane | sort
  sudo dnctl pipe show 2>/dev/null | grep -E '^[0-9]+:' | awk '{print $1}' | sort
}
kept() {
  if [ -n "${NETSIM_SNAPSHOT_IGNORE:-}" ]; then grep -Ev -- "$NETSIM_SNAPSHOT_IGNORE" "$1"; else cat "$1"; fi
}

TMP=$(mktemp -d)
SERVER_PID=""
STARTED=0
teardown() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi
  SERVER_PID=""
  if [ "$STARTED" = 1 ]; then sudo bash "$HERE/netsim.sh" down >/dev/null; fi
  STARTED=0
}
trap 'teardown; rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

snapshot >"$TMP/before"

ids=$(for s in "${SPEC_LIST[@]}"; do echo "${s%%:*}"; done | paste -sd, -)
status=0
STARTED=1 # set before 'up', so a half-finished 'up' is torn down as well
if sudo bash "$HERE/netsim.sh" up "${SPEC_LIST[@]}"; then
  server_args=("$ids" 8090)
  v6=$(cat "$NETSIM_STATE/v6" 2>/dev/null)
  if [ "$v6" = ok ]; then
    export NETSIM_SERVER6=2001:db8:198:51:100::10
    server_args+=(2001:db8:77:99::1)
  else
    export NETSIM_V6_ERROR=${v6:-netsim recorded no IPv6 status}
  fi
  node "$HERE/server.mjs" "${server_args[@]}" >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -fsS --max-time 1 http://127.0.0.1:8090/stats >/dev/null 2>&1 && break; sleep 0.1; done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    NETSIM_SERVER=198.51.100.10 NETSIM_CONTROL=http://127.0.0.1:8090 NETSIM_LINKS="${ids//,/ }" "$@"
    status=$?
  else
    echo "with-netsim: the test server did not start:" >&2
    status=1
  fi
else
  echo "with-netsim: netsim up failed" >&2
  status=1
fi
teardown
cat "$TMP/server.log" 2>/dev/null

snapshot >"$TMP/after"
if ! diff -u <(kept "$TMP/before") <(kept "$TMP/after"); then
  echo "with-netsim: FAIL: the network state changed (diff above)" >&2
  exit 1
fi
if [ -n "${NETSIM_SNAPSHOT_IGNORE:-}" ] && ! diff -q "$TMP/before" "$TMP/after" >/dev/null; then
  echo "with-netsim: note: lines matching NETSIM_SNAPSHOT_IGNORE changed (macOS's own, not compared):"
  diff "$TMP/before" "$TMP/after" | grep -E '^[<>]' || true
fi
echo "with-netsim: network state restored"
exit "$status"
