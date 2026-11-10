#!/usr/bin/env bash
# Simulated internet links for CI (docs/DECISIONS.md ADR-0015). Run as root. macOS only.
#
# Each link N is a feth pair: fethN0 is the Mac's side (the "network interface" apps and the daemon
# see), fethN1 is the far side. Its gateway 10.77.N.1 is a static ARP entry pointing at fethN1, and
# a scoped default route through it makes fethN0 a link with its own default route, like a second
# Wi-Fi or a tethered phone. The "internet" is one server address, 198.51.100.10:80 (a documentation
# range never routed on the real internet). pf rdr on fethN1 sends it to the local test server on
# 10.77.99.1:808N, so the server can tell links apart by port and client address. Replies return over
# lo0, where dummynet shapes them; dummynet also shapes fethN0's outgoing traffic.
#
# usage:
#   netsim.sh up "<id>:<Mbit/s>:<delay ms>:<loss>" ...   e.g. up 1:20:10:0 2:50:10:0
#   netsim.sh drop <id> loss|down      make a link silently lose everything, or take it down
#   netsim.sh restore <id>             undo "drop <id> loss"
#   netsim.sh via <id>                 also make the server reachable unpinned (the Mac's default
#                                      route) through link <id>, as the real internet is
#   netsim.sh down                     remove everything netsim created (idempotent)
#   netsim.sh status
set -uo pipefail

ANCHOR=com.apple/mergelane-netsim
SERVER_IP=198.51.100.10
LOCAL_SERVER_IP=10.77.99.1
STATE_DIR=${NETSIM_STATE_DIR:-/var/run/mergelane-netsim}
PIPE_BASE=7700 # pipes 77N1 (towards the Mac) and 77N2 (away from it) belong to link N

log() { echo "netsim: $*"; }
die() {
  echo "netsim: error: $*" >&2
  exit 1
}
run() {
  if ! out=$("$@" 2>&1); then
    die "'$*' failed: $out"
  fi
}

[ "$(uname -s)" = Darwin ] || die "macOS only"
[ "$(id -u)" = 0 ] || die "run as root"

mac_of() { ifconfig "$1" | awk '/ether/{print $2; exit}'; }

link_ids() { [ -f "$STATE_DIR/links" ] && cut -d: -f1 "$STATE_DIR/links"; }

pipe_cfg() { # <Mbit/s> <delay ms> <loss>
  echo "bw ${1}Mbit/s delay $2 plr $3 queue 100"
}

write_rules() {
  local f
  f=$(mktemp)
  while IFS=: read -r id _ _ _; do
    echo "rdr on feth${id}1 inet proto tcp from any to $SERVER_IP port 80 -> $LOCAL_SERVER_IP port 808${id}"
  done <"$STATE_DIR/links" >>"$f"
  while IFS=: read -r id _ _ _; do
    echo "dummynet out quick on lo0 inet proto tcp from $LOCAL_SERVER_IP port 808${id} to any pipe $((PIPE_BASE + id * 10 + 1))"
    echo "dummynet out quick on feth${id}0 inet proto tcp all pipe $((PIPE_BASE + id * 10 + 2))"
  done <"$STATE_DIR/links" >>"$f"
  run pfctl -q -a "$ANCHOR" -f "$f"
  rm -f "$f"
}

cmd_up() {
  [ $# -ge 1 ] || die "usage: netsim.sh up <id>:<Mbit/s>:<delay ms>:<loss> ..."
  [ -f "$STATE_DIR/links" ] && die "already up; run 'netsim.sh down' first"
  mkdir -p "$STATE_DIR"
  : >"$STATE_DIR/links"
  for spec in "$@"; do
    IFS=: read -r id mbit delay loss <<<"$spec"
    [[ "$id" =~ ^[1-8]$ ]] || die "link id must be 1-8, got '$id'"
    [[ "$mbit" =~ ^[0-9]+$ && "$delay" =~ ^[0-9]+$ && "$loss" =~ ^(0|1|0\.[0-9]+)$ ]] || die "bad link spec '$spec'"
    echo "$id:$mbit:$delay:$loss" >>"$STATE_DIR/links"
  done
  run ifconfig lo0 alias "$LOCAL_SERVER_IP/32"
  while IFS=: read -r id mbit delay loss; do
    local c="feth${id}0" f="feth${id}1"
    run ifconfig "$c" create
    run ifconfig "$f" create
    run ifconfig "$c" peer "$f"
    run ifconfig "$c" inet "10.77.$id.2/24" up
    # The far side needs IPv4 attached to process the redirected packets; its own subnet is unused.
    run ifconfig "$f" inet "10.77.10$id.1/30" up
    run arp -s "10.77.$id.1" "$(mac_of "$f")" ifscope "$c"
    run route -q -n add -inet default "10.77.$id.1" -ifscope "$c"
    run dnctl pipe $((PIPE_BASE + id * 10 + 1)) config $(pipe_cfg "$mbit" "$delay" "$loss")
    run dnctl pipe $((PIPE_BASE + id * 10 + 2)) config $(pipe_cfg "$mbit" "$delay" "$loss")
    log "link $id: $c 10.77.$id.2, ${mbit} Mbit/s, ${delay} ms, loss $loss"
  done <"$STATE_DIR/links"
  write_rules
  local token
  token=$(pfctl -E 2>&1 | awk '/Token/{print $3}')
  echo "$token" >"$STATE_DIR/pf-token"
  log "up: server $SERVER_IP:80 via links $(link_ids | tr '\n' ' ')"
}

cmd_via() {
  local id=${1:?usage: netsim.sh via <id>}
  grep -q "^$id:" "$STATE_DIR/links" 2>/dev/null || die "no link $id"
  run route -q -n add -host "$SERVER_IP" "10.77.$id.1"
  echo "$id" >"$STATE_DIR/via"
  log "server reachable unpinned through link $id"
}

cmd_drop() {
  local id=${1:?usage: netsim.sh drop <id> loss|down} mode=${2:-loss}
  grep -q "^$id:" "$STATE_DIR/links" 2>/dev/null || die "no link $id"
  IFS=: read -r _ mbit delay _ <<<"$(grep "^$id:" "$STATE_DIR/links")"
  case $mode in
    loss)
      run dnctl pipe $((PIPE_BASE + id * 10 + 1)) config $(pipe_cfg "$mbit" "$delay" 1)
      run dnctl pipe $((PIPE_BASE + id * 10 + 2)) config $(pipe_cfg "$mbit" "$delay" 1)
      ;;
    down) run ifconfig "feth${id}0" down ;;
    *) die "drop mode must be loss or down" ;;
  esac
  log "link $id dropped ($mode)"
}

cmd_restore() {
  local id=${1:?usage: netsim.sh restore <id>}
  grep -q "^$id:" "$STATE_DIR/links" 2>/dev/null || die "no link $id"
  IFS=: read -r _ mbit delay loss <<<"$(grep "^$id:" "$STATE_DIR/links")"
  run dnctl pipe $((PIPE_BASE + id * 10 + 1)) config $(pipe_cfg "$mbit" "$delay" "$loss")
  run dnctl pipe $((PIPE_BASE + id * 10 + 2)) config $(pipe_cfg "$mbit" "$delay" "$loss")
  log "link $id restored"
}

# Removes everything netsim may have created, whether or not 'up' finished. Never fails.
cmd_down() {
  route -q -n delete -host "$SERVER_IP" >/dev/null 2>&1
  pfctl -q -a "$ANCHOR" -F all 2>/dev/null
  if [ -s "$STATE_DIR/pf-token" ]; then pfctl -q -X "$(cat "$STATE_DIR/pf-token")" 2>/dev/null; fi
  for id in 1 2 3 4 5 6 7 8; do
    route -q -n delete -inet default "10.77.$id.1" -ifscope "feth${id}0" >/dev/null 2>&1
    arp -d "10.77.$id.1" ifscope "feth${id}0" >/dev/null 2>&1
    dnctl pipe delete $((PIPE_BASE + id * 10 + 1)) 2>/dev/null
    dnctl pipe delete $((PIPE_BASE + id * 10 + 2)) 2>/dev/null
    ifconfig "feth${id}0" destroy 2>/dev/null
    ifconfig "feth${id}1" destroy 2>/dev/null
  done
  ifconfig lo0 -alias "$LOCAL_SERVER_IP" 2>/dev/null
  rm -rf "$STATE_DIR"
  log "down"
  return 0
}

cmd_status() {
  [ -f "$STATE_DIR/links" ] && cat "$STATE_DIR/links" || echo "not up"
  ifconfig -l | tr ' ' '\n' | grep '^feth' || true
  netstat -rn -f inet | grep -E 'feth|10\.77' || true
  dnctl pipe show 2>/dev/null | grep -E "^0?77[0-9]{2}:" || true
}

case ${1:-} in
  up) shift && cmd_up "$@" ;;
  drop) shift && cmd_drop "$@" ;;
  restore) shift && cmd_restore "$@" ;;
  via) shift && cmd_via "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) die "usage: netsim.sh up|via|drop|restore|down|status" ;;
esac
