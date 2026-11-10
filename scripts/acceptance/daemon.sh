#!/usr/bin/env bash
# Phase 1 acceptance tests for mergelane-daemon (docs/PHASE-1.md). CI only: needs passwordless sudo
# and changes the machine's routing. Run inside the simulated network:
#
#   scripts/netsim/with-netsim.sh "1:20:10:0 2:50:10:0" -- bash scripts/acceptance/daemon.sh
#
# Criteria covered here: 3 (system flows spread over both links; off leaves routing unchanged),
# 4 (kill -9 leaves no Mergelane routes; connectivity intact), 5 (refused while a VPN is up, and
# turns itself off when one appears, without touching the VPN's routes), and the system half of 6
# (new flows avoid a dead link within 5 s). Also: another user is refused (ADR-0005), and launchd
# restarts the daemon after kill -9 (ADR-0017).
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${RUNNER_TEMP:-$(mktemp -d)}/mergelane-acceptance
BIN=/tmp/mergelane-acceptance-bin # world-readable, so 'nobody' can run the client
COVER=$WORK/cover
LOG=$WORK/daemon.log
SERVER=${NETSIM_SERVER:-198.51.100.10}
CONTROL=${NETSIM_CONTROL:-http://127.0.0.1:8090}
DAEMON="$BIN/mergelane-daemon"
LABEL=io.github.zahidnoor7.mergelane.daemon
FAILED=0
DAEMON_PID=""
VPN_PID=""

step() { printf '\n=== %s\n' "$*"; }
pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*" >&2
  FAILED=$((FAILED + 1))
}

cleanup() {
  [ -n "$VPN_PID" ] && sudo kill "$VPN_PID" 2>/dev/null
  sudo pkill -f "$BIN/mergelane-daemon run" 2>/dev/null
  sudo "$DAEMON" uninstall >/dev/null 2>&1
  sudo "$DAEMON" cleanup >/dev/null 2>&1
  echo "--- daemon log"
  sudo cat "$LOG" 2>/dev/null | tail -60
}
trap cleanup EXIT

# Routes without cloned/link-layer entries (W) and without our utun's own address route.
routes() { netstat -rn -f inet | awk -v skip="${1:-^$}" 'NR>3 && $3 !~ /W/ && $4 !~ skip'; }
capture_routes() { netstat -rn -f inet | awk '$1 == "0/1" || $1 == "128.0/1"'; }
marked_routes() { netstat -rn -f inet | awk 'NR>3 && $3 ~ /2/'; }
our_utun() { "$DAEMON" status >/dev/null 2>&1 && netstat -rn -f inet | awk '$1 == "0/1" {print $4; exit}'; }
stats() { curl -fsS "$CONTROL/stats"; }
reset_stats() { curl -fsS -X POST "$CONTROL/reset" >/dev/null; }
link_requests() { stats | sed -E "s/.*\"$1\":\{\"bytes\":[0-9]+,\"requests\":([0-9]+).*/\1/"; }

start_daemon() {
  sudo env GOCOVERDIR="$COVER" "$DAEMON" run --allowed-uid "$(id -u)" --include feth10,feth20 \
    --probe-targets "$SERVER:80" --log "$LOG" &
  for _ in $(seq 1 100); do
    "$DAEMON" status >/dev/null 2>&1 && break
    sleep 0.1
  done
  DAEMON_PID=$(pgrep -f "$BIN/mergelane-daemon run" | head -1)
  "$DAEMON" status || return 1
}

wait_links_up() {
  for _ in $(seq 1 150); do
    local up
    up=$("$DAEMON" links 2>/dev/null | grep -c ' up  ')
    [ "$up" -ge 2 ] && return 0
    sleep 0.1
  done
  "$DAEMON" links
  return 1
}

start_vpn() { # [extra fakevpn flags]
  sudo "$BIN/fakevpn" "$@" >"$WORK/fakevpn.log" 2>&1 &
  for _ in $(seq 1 50); do grep -q FAKEVPN_READY "$WORK/fakevpn.log" 2>/dev/null && break; sleep 0.1; done
  cat "$WORK/fakevpn.log"
  VPN_UTUN=$(awk '/FAKEVPN_READY/{print $2}' "$WORK/fakevpn.log")
  VPN_PID=$(awk -F'pid=' '/FAKEVPN_READY/{print $2}' "$WORK/fakevpn.log")
}

stop_vpn() {
  [ -n "$VPN_PID" ] && sudo kill "$VPN_PID" 2>/dev/null
  VPN_PID=""
  sleep 0.5
}

parallel_curls() { # <count> <path> <max seconds>; prints one "code seconds" line per curl
  local pids=() i
  for i in $(seq 1 "$1"); do
    curl -s -o /dev/null -w '%{http_code} %{time_total}\n' --max-time "$3" "http://$SERVER$2" >"$WORK/curl.$i" &
    pids+=($!)
  done
  wait "${pids[@]}"
  for i in $(seq 1 "$1"); do cat "$WORK/curl.$i"; done
}

step "Build the daemon (with coverage) and the fake VPN"
rm -rf "$WORK" "$BIN" && mkdir -p "$WORK" "$COVER" "$BIN"
(cd "$ROOT/daemon" && go build -cover -o "$DAEMON" ./cmd/mergelane-daemon && go build -o "$BIN/fakevpn" ./cmd/fakevpn) || exit 1
chmod 755 "$BIN" "$DAEMON" && chmod 777 "$COVER"
"$DAEMON" list --include feth10,feth20

BEFORE=$(routes)
step "Start the daemon: off until asked"
start_daemon && pass "daemon answers on its socket" || { fail "daemon did not start"; exit 1; }
"$DAEMON" status | grep -q 'system merge: off' && pass "starts off" || fail "did not start off"
wait_links_up && pass "both simulated links probed up" || fail "links not up"

step "ADR-0005: another user is refused"
if out=$(sudo -u nobody "$DAEMON" status 2>&1); then
  fail "user nobody was allowed: $out"
else
  grep -q NOT_AUTHORIZED <<<"$out" && pass "nobody gets NOT_AUTHORIZED" || fail "unexpected refusal: $out"
fi

step "Criterion 3: system flows spread over both links"
"$DAEMON" on | grep -q 'system merge: on' && pass "enabled" || fail "enable failed"
UTUN=$(our_utun)
capture_routes
capture_routes | grep -q "$UTUN" && pass "capture routes on $UTUN" || fail "no capture routes"
capture_routes | awk '{print $3}' | grep -q 2 && pass "capture routes carry RTF_PROTO2 (flag 2)" || fail "capture routes are not marked"
reset_stats
results=$(parallel_curls 16 /file/4 60)
echo "$results"
ok=$(grep -c '^200 ' <<<"$results")
r1=$(link_requests 1)
r2=$(link_requests 2)
echo "requests: link 1 = $r1, link 2 = $r2"
[ "$ok" -eq 16 ] && pass "16/16 downloads through the utun succeeded" || fail "$ok/16 downloads succeeded"
[ "$r1" -ge 3 ] && [ "$r2" -ge 3 ] && pass "flows spread over both links ($r1 + $r2)" || fail "flows not spread ($r1 + $r2)"

step "Criterion 3: off leaves routing as it was"
"$DAEMON" off | grep -q 'system merge: off' && pass "disabled" || fail "disable failed"
AFTER=$(routes "^$UTUN\$")
if diff <(echo "$BEFORE") <(echo "$AFTER"); then pass "routing table unchanged (apart from the utun's own address)"; else fail "routing changed after off"; fi
if curl -fsS --max-time 3 -o /dev/null "http://$SERVER/whoami"; then fail "traffic still captured after off"; else pass "nothing captured after off"; fi

step "Criterion 5: enabling is refused while a VPN is up"
start_vpn
VPN_ROUTES=$(capture_routes)
if out=$("$DAEMON" on 2>&1); then
  fail "enabled despite the VPN: $out"
else
  echo "$out"
  grep -q VPN_ACTIVE <<<"$out" && grep -q "$VPN_UTUN" <<<"$out" && pass "refused with VPN_ACTIVE naming $VPN_UTUN" || fail "unclear refusal: $out"
fi
[ "$(capture_routes)" = "$VPN_ROUTES" ] && pass "VPN routes untouched" || fail "VPN routes changed"
stop_vpn

step "Criterion 5: a VPN appearing while merging is on turns merging off"
"$DAEMON" on >/dev/null || fail "enable failed"
start_vpn -replace
reason=""
for _ in $(seq 1 50); do
  st=$("$DAEMON" status)
  if grep -q 'system merge: off' <<<"$st"; then reason=$st; break; fi
  sleep 0.1
done
echo "$reason"
[ -n "$reason" ] && grep -q "$VPN_UTUN" <<<"$reason" && pass "turned off within 5 s, reason names $VPN_UTUN" || fail "did not turn off for the VPN"
capture_routes | grep -q "$VPN_UTUN" && pass "the VPN's routes survived our turning off" || fail "our cleanup removed the VPN's routes"
stop_vpn

step "Criterion 6 (system): new flows avoid a dead link within 5 s"
"$DAEMON" on >/dev/null || fail "enable failed"
wait_links_up || fail "links not up again"
sudo bash "$ROOT/scripts/netsim/netsim.sh" drop 2 loss
dropped=$(date +%s)
down=""
while [ $(($(date +%s) - dropped)) -le 5 ]; do
  "$DAEMON" links | grep '^feth20' | grep -q ' down ' && { down=yes; break; }
  sleep 0.2
done
echo "feth20 marked down after $(($(date +%s) - dropped)) s"
[ -n "$down" ] && pass "the dead link was marked down within 5 s" || fail "dead link not marked down within 5 s"
sleep $((5 - ($(date +%s) - dropped) > 0 ? 5 - ($(date +%s) - dropped) : 0))
reset_stats
results=$(parallel_curls 8 /file/1 20)
echo "$results"
slow=$(awk '$1 != 200 || $2 > 5 {n++} END {print n+0}' <<<"$results")
[ "$slow" -eq 0 ] && pass "8/8 new flows succeeded within 5 s each, over the live link" || fail "$slow new flows failed or waited on the dead link"
[ "$(link_requests 2)" -eq 0 ] && pass "no request arrived over the dead link" || fail "requests over the dead link"
sudo bash "$ROOT/scripts/netsim/netsim.sh" restore 2

step "A clean stop turns merging off and removes its routes"
sudo kill -TERM "$DAEMON_PID" # also writes this run's coverage counters
for _ in $(seq 1 50); do pgrep -f "$BIN/mergelane-daemon run" >/dev/null || break; sleep 0.1; done
if capture_routes | grep -q .; then fail "capture routes left after SIGTERM"; else pass "SIGTERM: no capture routes left"; fi

step "Criterion 4: kill -9 leaves no Mergelane routes; connectivity intact"
start_daemon >/dev/null || fail "daemon did not restart"
wait_links_up || fail "links not up"
"$DAEMON" on >/dev/null || fail "enable failed"
UTUN=$(our_utun)
capture_routes | grep -q "$UTUN" || fail "capture routes missing before the kill"
sudo kill -9 "$DAEMON_PID"
sleep 1
if capture_routes | grep -q .; then fail "capture routes survived kill -9"; else pass "capture routes died with the daemon"; fi
echo "marked routes left before cleanup (removed by the next start, ADR-0007):"
marked_routes
sudo "$DAEMON" cleanup
[ -z "$(marked_routes)" ] && pass "no marked routes after cleanup" || fail "marked routes remain after cleanup"
if diff <(echo "$BEFORE") <(routes); then pass "routing table back to its original state"; else fail "routing differs after kill -9 and cleanup"; fi
curl -fsS --max-time 15 -o /dev/null https://api.github.com/ && pass "internet works after kill -9" || fail "no connectivity after kill -9"

step "ADR-0017: launchd installs, restarts after kill -9, and uninstalls"
sudo "$DAEMON" install --uid "$(id -u)" --source "$DAEMON" && pass "installed" || fail "install failed"
for _ in $(seq 1 50); do "$DAEMON" status >/dev/null 2>&1 && break; sleep 0.1; done
pid1=$(sudo launchctl print "system/$LABEL" | awk '/^\tpid = /{print $3}')
"$DAEMON" status && pass "the launchd-run daemon answers (pid $pid1)" || fail "launchd-run daemon not answering"
sudo kill -9 "$pid1"
pid2=""
for _ in $(seq 1 50); do
  pid2=$(sudo launchctl print "system/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
  [ -n "$pid2" ] && [ "$pid2" != "$pid1" ] && break
  sleep 0.1
done
[ -n "$pid2" ] && [ "$pid2" != "$pid1" ] && pass "launchd restarted it (pid $pid1 -> $pid2)" || fail "not restarted"
sudo "$DAEMON" uninstall && pass "uninstalled" || fail "uninstall failed"
[ ! -e "/Library/LaunchDaemons/$LABEL.plist" ] && [ ! -e "/Library/PrivilegedHelperTools/$LABEL" ] && pass "files removed" || fail "files left behind"
if diff <(echo "$BEFORE") <(routes); then pass "routing table unchanged after uninstall"; else fail "routing differs after uninstall"; fi

step "Coverage of the daemon binary in these runs"
go tool covdata percent -i="$COVER" 2>/dev/null | grep -E 'cmd/mergelane-daemon|internal/(control|tun|api|vpnguard|routemark|rib|launchd)\s' || true

echo
if [ "$FAILED" -eq 0 ]; then echo "daemon acceptance: PASS"; else echo "daemon acceptance: $FAILED FAILED"; fi
exit "$FAILED"
