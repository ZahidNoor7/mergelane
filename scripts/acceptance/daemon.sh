#!/usr/bin/env bash
# Phase 1 acceptance tests for mergelane-daemon (docs/PHASE-1.md). CI only: needs passwordless sudo
# and changes the machine's routing. Run inside the simulated network:
#
#   scripts/netsim/with-netsim.sh "1:20:10:0 2:50:10:0" -- bash scripts/acceptance/daemon.sh
#
# Criteria covered here: 3 (system flows spread over both links; off leaves routing unchanged),
# 4 (kill -9 leaves no Mergelane routes; connectivity intact), 5 (refused while a VPN is up, and
# turns itself off when one appears, without touching the VPN's routes), and the system half of 6
# (new flows avoid a dead link within 5 s). Also: another user is refused (ADR-0005), launchd
# restarts the daemon after kill -9 (ADR-0017), auto-resume turns merging back on after kill -9
# but not after a clean stop (ADR-0024), IPv6 flows are captured and spread over the links with
# -ipv6 on (PHASE-2 M2.4), and a link that goes down and comes back is avoided, then used again
# (ADR-0025).
#
# On a Mac with Mergelane installed, run it only through scripts/ci/local-root.sh: the ADR-0017
# section installs and uninstalls the LaunchDaemon under the real label, and every test daemon needs
# the single-instance lock the installed helper holds. local-root.sh pauses and backs up the helper,
# sets MERGELANE_HELPER_BACKED_UP, and restores it afterwards; without that this script refuses.
#
# shellcheck disable=SC2015 # pass() always returns 0, so "check && pass || fail" never fails a pass
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=${RUNNER_TEMP:-$(mktemp -d)}/mergelane-acceptance
BIN=/tmp/mergelane-acceptance-bin # world-readable, so 'nobody' can run the client
COVER=$WORK/cover
LOG=$WORK/daemon.log
SERVER=${NETSIM_SERVER:-198.51.100.10}
CONTROL=${NETSIM_CONTROL:-http://127.0.0.1:8090}
SERVER6=${NETSIM_SERVER6:-}
DAEMON="$BIN/mergelane-daemon"
LABEL=io.github.zahidnoor7.mergelane.daemon
# Hand-started daemons keep their prefs (auto-resume, wantOn) here, away from the installed
# helper's /Library/Application Support/Mergelane/daemon. Root-owned: /var/run is not user-writable.
STATE=/var/run/mergelane-acceptance
FAILED=0
DAEMON_PID=""
VPN_PID=""
INSTALLED=0 # the ADR-0017 section has (maybe partly) installed the LaunchDaemon

step() { printf '\n=== %s\n' "$*"; }
pass() { echo "PASS: $*"; }
fail() {
  echo "FAIL: $*" >&2
  FAILED=$((FAILED + 1))
}

# shellcheck disable=SC2329 # run by the EXIT trap below
cleanup() {
  [ -n "$VPN_PID" ] && sudo kill "$VPN_PID" 2>/dev/null
  sudo pkill -f "$BIN/mergelane-daemon run" 2>/dev/null
  # Only a LaunchDaemon this script installed is removed, never one it found.
  [ "$INSTALLED" = 1 ] && sudo "$DAEMON" uninstall >/dev/null 2>&1
  [ -x "$DAEMON" ] && sudo "$DAEMON" cleanup >/dev/null 2>&1
  sudo rm -rf "$STATE"
  echo "--- daemon log"
  sudo cat "$LOG" 2>/dev/null | tail -60
}

if pgrep -f "^/Library/PrivilegedHelperTools/$LABEL run" >/dev/null 2>&1; then
  echo "daemon.sh: the installed Mergelane helper is running; run this through scripts/ci/local-root.sh," \
    "which pauses it and restores it afterwards" >&2
  exit 2
fi
if { [ -e "/Library/LaunchDaemons/$LABEL.plist" ] || [ -e "/Library/PrivilegedHelperTools/$LABEL" ]; } &&
  [ -z "${MERGELANE_HELPER_BACKED_UP:-}" ]; then
  echo "daemon.sh: Mergelane's helper is installed here, and the ADR-0017 section would replace and then" \
    "remove it. Run this through scripts/ci/local-root.sh, which backs it up and restores it." >&2
  exit 2
fi
trap cleanup EXIT

# Routes without cloned/link-layer entries (W) and without our utun's own address route. A feth
# pair that netsim destroyed and created again has new interface indexes and MAC addresses; those
# are not routing changes, so they are masked on feth lines.
routes() {
  netstat -rn -f inet | awk -v skip="${1:-^$}" 'NR>3 && $3 !~ /W/ && $4 !~ skip {
    if ($4 ~ /^feth/) {
      gsub(/link#[0-9]+/, "link#N")
      gsub(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, "MAC", $2)
    }
    print
  }'
}
# IPv6 routes (netstat -rn -f inet6 on stdin) likewise, without anything of the utun named in $1:
# its link-local and its fd6e:6d65:7267::/64 address, which stay while the daemon runs.
filter6() {
  awk -v skip="${1:+$1([^0-9]|\$)}" 'NR>3 && $3 !~ /W/ && $1 !~ /^fd6e:6d65:7267:/ && (skip == "" || $0 !~ skip)'
}
capture_routes() { netstat -rn -f inet | awk '$1 == "0/1" || $1 == "128.0/1"'; }
capture_routes6() { netstat -rn -f inet6 | awk '$1 == "::/1" || $1 == "8000::/1"'; }
marked_routes() { netstat -rn -f inet | awk 'NR>3 && $3 ~ /2/'; }
our_utun() { "$DAEMON" status >/dev/null 2>&1 && netstat -rn -f inet | awk '$1 == "0/1" {print $4; exit}'; }
stats() { curl -fsS "$CONTROL/stats"; }
reset_stats() { curl -fsS -X POST "$CONTROL/reset" >/dev/null; }
link_requests() { stats | sed -E "s/.*\"$1\":\{\"bytes\":[0-9]+,\"requests\":([0-9]+).*/\1/"; }

start_daemon() { # [more run flags; a repeated flag overrides]
  sudo env GOCOVERDIR="$COVER" "$DAEMON" run --allowed-uid "$(id -u)" --include feth10,feth20 \
    --probe-targets "$SERVER:80" --state-dir "$STATE" --log "$LOG" "$@" &
  for _ in $(seq 1 100); do
    "$DAEMON" status >/dev/null 2>&1 && break
    sleep 0.1
  done
  # The daemon itself, not the sudo that started it (killing sudo would leave the daemon running).
  DAEMON_PID=$(pgrep -f "^$BIN/mergelane-daemon run" | head -1)
  "$DAEMON" status || return 1
}

stop_daemon() { # SIGTERM, a clean stop; also writes this run's coverage counters
  sudo kill -TERM "$DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 50); do pgrep -f "^$BIN/mergelane-daemon run" >/dev/null || break; sleep 0.1; done
}

link_up() { "$DAEMON" links 2>/dev/null | grep "^$1 " | grep -q ' up  '; }

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
  # shellcheck disable=SC2024 # the log is written by this user's shell on purpose, so it can read it
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

parallel_curls() { # <count> <path> <max seconds> [base URL]; prints one "code seconds" line per curl
  local pids=() i base=${4:-http://$SERVER}
  for i in $(seq 1 "$1"); do
    curl -g -s -o /dev/null -w '%{http_code} %{time_total}\n' --max-time "$3" "$base$2" >"$WORK/curl.$i" &
    pids+=($!)
  done
  wait "${pids[@]}"
  for i in $(seq 1 "$1"); do cat "$WORK/curl.$i"; done
}

step "Build the daemon (with coverage) and the fake VPN"
rm -rf "$WORK" "$BIN" && mkdir -p "$WORK" "$COVER" "$BIN"
# root runs what is built here: a directory another local user made in /tmp first would let them
# swap the binaries.
if [ ! -O "$BIN" ] || [ -L "$BIN" ]; then
  echo "daemon.sh: $BIN is not a directory of $(id -un)'s; remove it and run again" >&2
  exit 1
fi
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
for _ in $(seq 1 50); do pgrep -f "^$BIN/mergelane-daemon run" >/dev/null || break; sleep 0.1; done
if capture_routes | grep -q .; then fail "capture routes left after SIGTERM"; else pass "SIGTERM: no capture routes left"; fi

step "Criterion 4: kill -9 leaves no Mergelane routes; connectivity intact"
start_daemon >/dev/null || fail "daemon did not restart"
wait_links_up || fail "links not up"
"$DAEMON" on >/dev/null || fail "enable failed"
UTUN=$(our_utun)
capture_routes | grep -q "$UTUN" || fail "capture routes missing before the kill"
echo "kill -9 daemon pid $DAEMON_PID"
sudo kill -9 "$DAEMON_PID"
sleep 1
pgrep -fl "^$BIN/mergelane-daemon run" && fail "the daemon survived kill -9"
if capture_routes | grep -q .; then fail "capture routes survived kill -9"; else pass "capture routes died with the daemon"; fi
echo "marked routes left before cleanup (removed by the next start, ADR-0007):"
marked_routes
sudo "$DAEMON" cleanup
[ -z "$(marked_routes)" ] && pass "no marked routes after cleanup" || fail "marked routes remain after cleanup"
if diff <(echo "$BEFORE") <(routes); then pass "routing table back to its original state"; else fail "routing differs after kill -9 and cleanup"; fi
curl -fsS --max-time 15 -o /dev/null https://api.github.com/ && pass "internet works after kill -9" || fail "no connectivity after kill -9"

step "ADR-0024: with auto-resume on, merging comes back after kill -9, but not after a clean stop"
# The restart is done by hand with the same flags, standing in for launchd (whose job has fixed
# arguments and would probe the runner's real internet links instead of the simulated ones).
start_daemon >/dev/null || fail "daemon did not start"
wait_links_up || fail "links not up"
"$DAEMON" auto-resume on | grep -q '^auto-resume after a crash: on' && pass "auto-resume turned on" || fail "auto-resume on failed"
"$DAEMON" on >/dev/null || fail "enable failed"
echo "kill -9 daemon pid $DAEMON_PID"
sudo kill -9 "$DAEMON_PID"
sleep 1
start_daemon >/dev/null || fail "daemon did not restart after kill -9"
resumed=""
for _ in $(seq 1 200); do # the daemon waits up to 10 s for a link to pass its probe
  "$DAEMON" status 2>/dev/null | grep -q '^system merge: on ' && resumed=1 && break
  sleep 0.1
done
[ -n "$resumed" ] && pass "merging came back on by itself after kill -9" || fail "merging did not resume after kill -9"
UTUN=$(our_utun)
[ -n "$UTUN" ] && capture_routes | grep -q "$UTUN" && pass "capture routes back, on $UTUN" || fail "no capture routes after resume"
"$DAEMON" events | grep -qE ' (found|probe-ok)$' && pass "the restarted daemon logs link changes" || fail "no link events after the restart"
sudo kill -TERM "$DAEMON_PID"
for _ in $(seq 1 50); do pgrep -f "^$BIN/mergelane-daemon run" >/dev/null || break; sleep 0.1; done
start_daemon >/dev/null || fail "daemon did not restart after a clean stop"
sleep 12 # longer than auto-resume's wait, so a wrong resume would have happened by now
"$DAEMON" status | grep -q '^system merge: off ' && pass "a clean stop starts off, even with auto-resume on" || fail "merging resumed after a clean stop"
capture_routes | grep -q . && fail "capture routes after a clean restart" || pass "no capture routes after a clean restart"
"$DAEMON" auto-resume off >/dev/null || fail "auto-resume off failed"
sudo kill -TERM "$DAEMON_PID"
for _ in $(seq 1 50); do pgrep -f "^$BIN/mergelane-daemon run" >/dev/null || break; sleep 0.1; done
if diff <(echo "$BEFORE") <(routes); then pass "routing table back to its original state"; else fail "routing differs after the auto-resume runs"; fi

step "M2.4: IPv6 is captured by the utun and spread over both links (-ipv6 on)"
if [ -z "$SERVER6" ]; then
  fail "the simulated links carry no IPv6, so IPv6 capture could not be tested: ${NETSIM_V6_ERROR:-no reason given}"
else
  start_daemon -ipv6 on --probe-targets "$SERVER:80,[$SERVER6]:80" >/dev/null || fail "daemon did not start with -ipv6 on"
  wait_links_up || fail "links not up"
  BEFORE6=$(netstat -rn -f inet6) # filtered below, once the utun's name is known
  "$DAEMON" on | grep -q 'system merge: on' && pass "enabled with -ipv6 on" || fail "enable failed"
  UTUN=$(our_utun)
  capture_routes6
  [ "$(capture_routes6 | awk -v u="$UTUN" '$4 == u && $3 ~ /2/' | wc -l)" -eq 2 ] &&
    pass "::/1 and 8000::/1 on $UTUN, marked RTF_PROTO2" || fail "no marked IPv6 capture routes on $UTUN"
  reset_stats
  results=$(parallel_curls 16 /file/4 60 "http://[$SERVER6]")
  echo "$results"
  ok=$(grep -c '^200 ' <<<"$results")
  r1=$(link_requests 1)
  r2=$(link_requests 2)
  echo "IPv6 requests: link 1 = $r1, link 2 = $r2"
  [ "$ok" -eq 16 ] && pass "16/16 IPv6 downloads through the utun succeeded" || fail "$ok/16 IPv6 downloads succeeded"
  [ "$r1" -ge 3 ] && [ "$r2" -ge 3 ] && pass "IPv6 flows spread over both links ($r1 + $r2)" || fail "IPv6 flows not spread ($r1 + $r2)"
  stats | grep -q '2001:db8:77:1::2' && stats | grep -q '2001:db8:77:2::2' &&
    pass "the server saw each link's own IPv6 address" || fail "the daemon did not dial out over IPv6 on both links: $(stats)"
  "$DAEMON" off | grep -q 'system merge: off' && pass "disabled" || fail "disable failed"
  if diff <(filter6 "$UTUN" <<<"$BEFORE6") <(netstat -rn -f inet6 | filter6 "$UTUN"); then
    pass "IPv6 routing table unchanged after off (apart from the utun's own entries)"
  else
    fail "IPv6 routing changed after off"
  fi
  if curl -g -fsS --max-time 3 -o /dev/null "http://[$SERVER6]/whoami"; then fail "IPv6 still captured after off"; else pass "no IPv6 captured after off"; fi
  stop_daemon
fi

step "ADR-0025: a link that goes down and comes back is avoided, then used again"
start_daemon >/dev/null || fail "daemon did not start"
wait_links_up || fail "links not up"
"$DAEMON" on >/dev/null || fail "enable failed"
for mode in down gone; do
  sudo bash "$ROOT/scripts/netsim/netsim.sh" drop 2 "$mode"
  dropped=$(date +%s)
  gone=""
  while [ $(($(date +%s) - dropped)) -le 10 ]; do
    link_up feth20 || { gone=yes; break; }
    sleep 0.2
  done
  [ -n "$gone" ] && pass "($mode) feth20 out of use after $(($(date +%s) - dropped)) s" || fail "($mode) feth20 still up 10 s after it went"
  reset_stats
  results=$(parallel_curls 8 /file/1 20)
  echo "$results"
  slow=$(awk '$1 != 200 || $2 > 5 {n++} END {print n+0}' <<<"$results")
  [ "$slow" -eq 0 ] && pass "($mode) 8/8 new flows succeeded within 5 s each" || fail "($mode) $slow new flows failed or were slow"
  [ "$(link_requests 2)" -eq 0 ] && pass "($mode) no request went over the missing link" || fail "($mode) requests over the missing link"
  sudo bash "$ROOT/scripts/netsim/netsim.sh" restore 2
  restored=$(date +%s)
  back=""
  for _ in $(seq 1 150); do
    link_up feth20 && { back=yes; break; }
    sleep 0.1
  done
  [ -n "$back" ] && pass "($mode) feth20 up again after $(($(date +%s) - restored)) s" || fail "($mode) feth20 not up 15 s after it came back"
  reset_stats
  results=$(parallel_curls 16 /file/1 30)
  ok=$(grep -c '^200 ' <<<"$results")
  r2=$(link_requests 2)
  echo "after the return: $ok/16 succeeded, $r2 over link 2"
  [ "$ok" -eq 16 ] && [ "$r2" -ge 2 ] && pass "($mode) new flows use feth20 again ($r2 of 16)" || fail "($mode) feth20 not used again ($ok/16 ok, $r2 over it)"
done
events=$("$DAEMON" events | grep ' feth20 ')
echo "$events"
# Each drop must show as lost or probe-failed, followed by returned or probe-ok.
cycles=$(awk '/ (lost|probe-failed)$/ {down = 1} down && / (returned|probe-ok)$/ {n++; down = 0} END {print n + 0}' <<<"$events")
[ "$cycles" -ge 2 ] && pass "events show feth20 leaving and returning, twice" || fail "events show $cycles leave-and-return cycles, want 2"
"$DAEMON" off >/dev/null || fail "disable failed"
stop_daemon
if diff <(echo "$BEFORE") <(routes); then pass "routing table back to its original state"; else fail "routing differs after the link came back"; fi

step "ADR-0017: launchd installs, restarts after kill -9, and uninstalls"
INSTALLED=1
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
(cd "$ROOT/daemon" && go tool covdata percent -i="$COVER") || echo "(no coverage data)"

echo
if [ "$FAILED" -eq 0 ]; then echo "daemon acceptance: PASS"; else echo "daemon acceptance: $FAILED FAILED"; fi
exit "$FAILED"
