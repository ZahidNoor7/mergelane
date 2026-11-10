#!/usr/bin/env bash
# Runs a command inside a fresh simulated network (netsim.sh), always tears it down, and fails if
# the Mac's network state afterwards differs from before: routes, interfaces, pf anchors and
# dummynet pipes. Run as a normal user with passwordless sudo (CI runners have it).
#
# usage: scripts/netsim/with-netsim.sh "<id>:<Mbit/s>:<delay ms>:<loss> ..." -- <command> [args...]
# The command sees NETSIM_SERVER=198.51.100.10, NETSIM_CONTROL=http://127.0.0.1:8090 and NETSIM_LINKS
# (e.g. "1 2"). The test server runs for the whole command.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SPECS=${1:?usage: with-netsim.sh "<specs>" -- <command...>}
shift
[ "${1:-}" = "--" ] && shift
[ $# -ge 1 ] || { echo "with-netsim: no command given" >&2; exit 2; }

snapshot() {
  # Cloned and link-layer entries (W flag) come and go on their own; everything else must match.
  netstat -rn -f inet | awk 'NR>3 && $3 !~ /W/'
  netstat -rn -f inet6 | awk 'NR>3 && $3 !~ /W/'
  ifconfig -l | tr ' ' '\n' | sort
  sudo pfctl -s Anchors 2>/dev/null | sort
  sudo dnctl pipe show 2>/dev/null | grep -E '^[0-9]+:' | awk '{print $1}' | sort
}

BEFORE=$(mktemp)
AFTER=$(mktemp)
SERVER_LOG=$(mktemp)
trap 'rm -f "$BEFORE" "$AFTER" "$SERVER_LOG"' EXIT
snapshot >"$BEFORE"

SERVER_PID=""
teardown() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  sudo bash "$HERE/netsim.sh" down >/dev/null
}

ids=$(for s in $SPECS; do echo "${s%%:*}"; done | paste -sd, -)
status=0
if sudo bash "$HERE/netsim.sh" up $SPECS; then
  node "$HERE/server.mjs" "$ids" 8090 >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -fsS --max-time 1 http://127.0.0.1:8090/stats >/dev/null 2>&1 && break; sleep 0.1; done
  NETSIM_SERVER=198.51.100.10 NETSIM_CONTROL=http://127.0.0.1:8090 NETSIM_LINKS="${ids//,/ }" "$@"
  status=$?
else
  echo "with-netsim: netsim up failed" >&2
  status=1
fi
teardown
cat "$SERVER_LOG"

snapshot >"$AFTER"
if ! diff -u "$BEFORE" "$AFTER"; then
  echo "with-netsim: FAIL: the network state changed (diff above)" >&2
  exit 1
fi
echo "with-netsim: network state restored"
exit "$status"
