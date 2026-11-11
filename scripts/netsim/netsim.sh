#!/usr/bin/env bash
# Simulated internet links (docs/DECISIONS.md ADR-0015). Run as root. macOS only.
#
# Each link N is a feth pair: fethN0 is the Mac's side (the "network interface" apps and the daemon
# see), fethN1 is the far side. Its gateway 10.77.N.1 is a static ARP entry pointing at fethN1, and
# a scoped default route through it makes fethN0 a link with its own default route, like a second
# Wi-Fi or a tethered phone. The "internet" is one server address, 198.51.100.10:80 (a documentation
# range never routed on the real internet). pf rdr on fethN1 sends it to the local test server on
# 10.77.99.1:808N, so the server can tell links apart by port and client address. Replies return over
# lo0, where dummynet shapes them; dummynet also shapes fethN0's outgoing traffic.
#
# IPv6 (PHASE-2 M2.4), best effort: the same again with documentation addresses (RFC 3849):
# fethN0 2001:db8:77:N::2/64, gateway 2001:db8:77:N::1 (a static NDP entry for fethN1), a scoped
# IPv6 default, and the server [2001:db8:198:51:100::10]:80 redirected to [2001:db8:77:99::1]:808N
# on lo0. Global (not ULA) addresses, because the daemon only uses a link's global IPv6 address
# (nics.DiscoverNicsDetailed skips fc00::/7). If any IPv6 step fails, the links stay IPv4-only and
# $STATE_DIR/v6 says why; 'up' still succeeds.
#
# Safe on a personal Mac, not just a throwaway CI runner:
#   - 'up' refuses before changing anything if a name or number it would use is taken: a feth
#     interface, a dummynet pipe (77N1, 77N2), a lo0 address or its pf anchor;
#   - everything is recorded in $STATE_DIR before it is created, and 'down' removes exactly that;
#   - pf: only the anchor com.apple/mergelane-netsim is ever loaded or emptied (pfctl(8): with -a,
#     "-f, -F, and -s" apply only to that anchor), and pf is enabled with a reference token
#     (pfctl -E, released with -X), as /etc/pf.conf asks. The main ruleset, the state table and pf's
#     other anchors are never flushed, and 'pfctl -F all' is not used.
#
# usage:
#   netsim.sh up "<id>:<Mbit/s>:<delay ms>:<loss>" ...   e.g. up 1:20:10:0 2:50:10:0
#   netsim.sh drop <id> loss|down|gone  silent loss (dummynet plr 1), 'ifconfig down', or the feth
#                                      pair destroyed (it comes back with new interface indexes)
#   netsim.sh restore <id>             undo the last drop of <id>: the link carries traffic again
#   netsim.sh via <id>                 also make the server reachable unpinned (the Mac's default
#                                      route) through link <id>, as the real internet is
#   netsim.sh down [--sweep]           remove everything netsim recorded (idempotent). --sweep also
#                                      removes leftovers it can identify without its records
#   netsim.sh status
#
# NETSIM_DRY_RUN=1 prints every command that would change the system instead of running it; it needs
# no root, and read-only queries still run. NETSIM_STATE_DIR moves the state directory (for tests and
# dry runs); it is ignored when running as root.
set -uo pipefail

ANCHOR=com.apple/mergelane-netsim
SERVER_IP=198.51.100.10
LOCAL_SERVER_IP=10.77.99.1
SERVER_IP6=2001:db8:198:51:100::10
LOCAL_SERVER_IP6=2001:db8:77:99::1
PIPE_BASE=7700 # pipes 77N1 (towards the Mac) and 77N2 (away from it) belong to link N
DEFAULT_STATE_DIR=/var/run/mergelane-netsim
DRY=${NETSIM_DRY_RUN:-0}

log() { echo "netsim: $*"; }
die() {
  echo "netsim: error: $*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || die "macOS only"
OWN_TMP=""
if [ "$DRY" = 1 ] && { [ "$(id -u)" = 0 ] || [ -z "${NETSIM_STATE_DIR:-}" ]; }; then
  OWN_TMP=$(mktemp -d) # a dry run never touches the real state directory
  STATE_DIR=$OWN_TMP
  trap 'rm -rf "$OWN_TMP"' EXIT
elif [ "$(id -u)" = 0 ]; then
  STATE_DIR=$DEFAULT_STATE_DIR # never a path from the environment: 'down' runs rm -rf on it as root
elif [ "$DRY" = 1 ]; then
  STATE_DIR=$NETSIM_STATE_DIR
else
  die "run as root (or NETSIM_DRY_RUN=1 to print the commands without running them)"
fi

# run: a command that changes the system. Printed in a dry run; otherwise a failure is fatal.
run() {
  if [ "$DRY" = 1 ]; then
    echo "+ $*"
    return 0
  fi
  local out
  if ! out=$("$@" 2>&1); then
    die "'$*' failed: $out"
  fi
}
# try: the same, for cleanup and re-add steps whose failure is expected or harmless.
try() {
  if [ "$DRY" = 1 ]; then
    echo "+ $*"
    return 0
  fi
  "$@" >/dev/null 2>&1
}
# v6run: an IPv6 step. The first failure is kept in V6_ERR and every later IPv6 step is skipped.
V6_ERR=""
v6run() {
  [ -n "$V6_ERR" ] && return 1
  if [ "$DRY" = 1 ]; then
    echo "+ $*"
    return 0
  fi
  local out
  if ! out=$("$@" 2>&1); then
    V6_ERR="'$*' failed: ${out:-no output}"
    return 1
  fi
}

# Records a name or number in $STATE_DIR/<file> once, before netsim creates it.
record() { grep -qxF -- "$2" "$STATE_DIR/$1" 2>/dev/null || echo "$2" >>"$STATE_DIR/$1"; }
recorded() { if [ -f "$STATE_DIR/$1" ]; then cat "$STATE_DIR/$1"; fi; }

iface_exists() { ifconfig "$1" >/dev/null 2>&1; }
pipe_exists() { dnctl pipe show 2>/dev/null | grep -qE "^0*$1:"; }
mac_of() {
  local mac
  mac=$(ifconfig "$1" 2>/dev/null | awk '/ether/{print $2; exit}')
  if [ -z "$mac" ] && [ "$DRY" = 1 ]; then mac="<mac-of-$1>"; fi
  echo "$mac"
}
lo0_has() { ifconfig lo0 2>/dev/null | grep -qE "inet6? $1( |$)"; }
anchor_in_use() {
  local what
  for what in rules nat dummynet; do
    [ -n "$(pfctl -q -a "$ANCHOR" -s "$what" 2>/dev/null)" ] && return 0
  done
  return 1
}
link_ids() { [ -f "$STATE_DIR/links" ] && cut -d: -f1 "$STATE_DIR/links"; }
link_spec() { grep "^$1:" "$STATE_DIR/links" 2>/dev/null; }
v6_ok() { [ "$(cat "$STATE_DIR/v6" 2>/dev/null)" = ok ]; }
pipe_in() { echo $((PIPE_BASE + $1 * 10 + 1)); } # towards the Mac
pipe_out() { echo $((PIPE_BASE + $1 * 10 + 2)); }

pipe_config() { # <pipe> <Mbit/s> <delay ms> <loss>
  run dnctl pipe "$1" config bw "${2}Mbit/s" delay "$3" plr "$4" queue 100
}

need_link() { # <id>: the link exists in this run
  [[ "${1:-}" =~ ^[1-8]$ ]] || die "link id must be 1-8, got '${1:-}'"
  link_spec "$1" >/dev/null || die "no link $1"
}

rules() {
  local id
  for id in $(link_ids); do
    echo "rdr on feth${id}1 inet proto tcp from any to $SERVER_IP port 80 -> $LOCAL_SERVER_IP port 808${id}"
    if v6_ok; then
      echo "rdr on feth${id}1 inet6 proto tcp from any to $SERVER_IP6 port 80 -> $LOCAL_SERVER_IP6 port 808${id}"
    fi
  done
  for id in $(link_ids); do
    echo "dummynet out quick on lo0 inet proto tcp from $LOCAL_SERVER_IP port 808${id} to any pipe $(pipe_in "$id")"
    if v6_ok; then
      echo "dummynet out quick on lo0 inet6 proto tcp from $LOCAL_SERVER_IP6 port 808${id} to any pipe $(pipe_in "$id")"
    fi
    echo "dummynet out quick on feth${id}0 proto tcp all pipe $(pipe_out "$id")"
  done
}

write_rules() {
  local f
  f=$(mktemp)
  rules >"$f"
  if [ "$DRY" = 1 ]; then
    echo "+ pfctl -q -a $ANCHOR -f <rules>"
    sed 's/^/  | /' "$f"
  else
    run pfctl -q -a "$ANCHOR" -f "$f"
  fi
  rm -f "$f"
}

# Empties netsim's own anchor: loading an empty file replaces every ruleset in that anchor (rdr and
# dummynet included), and -F rules / -F nat with -a are the documented anchor-scoped flushes.
clear_anchor() {
  local empty
  empty=$(mktemp)
  try pfctl -q -a "$ANCHOR" -f "$empty"
  try pfctl -q -a "$ANCHOR" -F rules
  try pfctl -q -a "$ANCHOR" -F nat
  rm -f "$empty"
}

create_pair() { # <id>
  local c="feth${1}0" f="feth${1}1"
  record ifaces "$c"
  run ifconfig "$c" create
  record ifaces "$f"
  run ifconfig "$f" create
  run ifconfig "$c" peer "$f"
}

address_link() { # <id>
  run ifconfig "feth${1}0" inet "10.77.$1.2/24" up
  # The far side needs IPv4 attached to process the redirected packets; its own subnet is unused.
  run ifconfig "feth${1}1" inet "10.77.10$1.1/30" up
}

# (Re)adds the gateway's static ARP entry and the link's scoped default route. Also used after
# 'ifconfig down' and 'up': XNU's rip_ctlinput(PRC_IFDOWN) calls in_ifadown(ifa, 1), which deletes
# every IPv4 route using the link's address, static ones included (the ARP entry, this scoped default
# and a 'via' host route), and PRC_IFUP puts back only the interface route (xnu bsd/netinet/raw_ip.c,
# in_rmx.c). That is why a link stayed dead after 'up' in spike S1 (ADR-0015).
route_link() { # <id>
  local id=$1 c="feth${1}0"
  try arp -d "10.77.$id.1" ifscope "$c"
  run arp -s "10.77.$id.1" "$(mac_of "feth${id}1")" ifscope "$c"
  try route -q -n delete -inet default "10.77.$id.1" -ifscope "$c"
  run route -q -n add -inet default "10.77.$id.1" -ifscope "$c"
}

# Waits until an interface has no tentative (duplicate-address-detection) IPv6 address left.
v6_settle() { # <iface>
  [ -n "$V6_ERR" ] && return 1
  [ "$DRY" = 1 ] && return 0
  local _
  for _ in $(seq 1 50); do
    ifconfig "$1" inet6 2>/dev/null | grep -q tentative || return 0
    sleep 0.1
  done
  V6_ERR="$1 still has a tentative IPv6 address after 5 s: $(ifconfig "$1" inet6 2>&1 | tr '\n' ' ')"
  return 1
}

v6_route_link() { # <id>: the gateway's static NDP entry and the scoped IPv6 default
  local id=$1 c="feth${1}0" gw="2001:db8:77:$1::1"
  if ! v6_settle "$c" || ! v6_settle "feth${id}1"; then return 1; fi
  try ndp -d "$gw"
  v6run ndp -s "$gw" "$(mac_of "feth${id}1")" || return 1
  try route -q -n delete -inet6 default "$gw" -ifscope "$c"
  v6run route -q -n add -inet6 default "$gw" -ifscope "$c"
}

v6_link() { # <id>
  local id=$1
  v6run ifconfig "feth${id}0" inet6 "2001:db8:77:$id::2" prefixlen 64 alias || return 1
  v6run ifconfig "feth${id}1" inet6 "2001:db8:77:10$id::1" prefixlen 64 alias || return 1
  v6_route_link "$id"
}

v6_up() {
  local id
  record lo0 "$LOCAL_SERVER_IP6"
  v6run ifconfig lo0 inet6 "$LOCAL_SERVER_IP6" prefixlen 128 alias
  for id in $(link_ids); do v6_link "$id"; done
  if [ -z "$V6_ERR" ]; then
    echo ok >"$STATE_DIR/v6"
    log "IPv6: server [$SERVER_IP6]:80 through each link"
  else
    echo "unavailable: $V6_ERR" >"$STATE_DIR/v6"
    log "IPv6 unavailable, links are IPv4 only: $V6_ERR"
  fi
}

# Removes a host route to the server only if it points at one of netsim's gateways.
del_via_route() { # inet|inet6 <dst>
  local gw
  gw=$(route -n get "-$1" "$2" 2>/dev/null | awk '/gateway:/{print $2}')
  case $gw in
    10.77.* | 2001:db8:77:*) try route -q -n delete "-$1" -host "$2" ;;
  esac
}

via_routes() { # <id>: (re)adds the unpinned host routes to the server through link <id>
  local id=$1
  if [ "$DRY" = 1 ]; then
    try route -q -n delete -inet -host "$SERVER_IP"
  else
    del_via_route inet "$SERVER_IP"
  fi
  run route -q -n add -inet -host "$SERVER_IP" "10.77.$id.1"
  if v6_ok; then
    if [ "$DRY" = 1 ]; then try route -q -n delete -inet6 -host "$SERVER_IP6"; else del_via_route inet6 "$SERVER_IP6"; fi
    run route -q -n add -inet6 -host "$SERVER_IP6" "2001:db8:77:$id::1"
  fi
}

cmd_up() {
  [ $# -ge 1 ] || die "usage: netsim.sh up <id>:<Mbit/s>:<delay ms>:<loss> ..."
  [ -f "$STATE_DIR/links" ] && die "already up; run 'netsim.sh down' first"
  local spec id mbit delay loss seen=" " specs=() i p
  for spec in "$@"; do
    IFS=: read -r id mbit delay loss <<<"$spec"
    [[ "$id" =~ ^[1-8]$ ]] || die "link id must be 1-8, got '$id'"
    [[ "$mbit" =~ ^[0-9]+$ && "$delay" =~ ^[0-9]+$ && "$loss" =~ ^(0|1|0\.[0-9]+)$ ]] || die "bad link spec '$spec'"
    [[ "$seen" == *" $id "* ]] && die "link $id given twice"
    seen="$seen$id "
    specs+=("$id:$mbit:$delay:$loss")
  done
  # Nothing is changed until every name and number netsim needs is known to be free.
  for spec in "${specs[@]}"; do
    id=${spec%%:*}
    for i in "feth${id}0" "feth${id}1"; do
      iface_exists "$i" && die "$i already exists and netsim did not create it; destroy it or use another link id"
    done
    for p in "$(pipe_in "$id")" "$(pipe_out "$id")"; do
      pipe_exists "$p" && die "dummynet pipe $p already exists; netsim reserves 77N1 and 77N2 for link N"
    done
  done
  for i in "$LOCAL_SERVER_IP" "$LOCAL_SERVER_IP6"; do
    lo0_has "$i" && die "lo0 already has $i; netsim needs it for its test server"
  done
  anchor_in_use && die "pf anchor $ANCHOR already has rules; run 'netsim.sh down' first"

  mkdir -p "$STATE_DIR"
  printf '%s\n' "${specs[@]}" >"$STATE_DIR/links"
  record lo0 "$LOCAL_SERVER_IP"
  run ifconfig lo0 alias "$LOCAL_SERVER_IP/32"
  while IFS=: read -r id mbit delay loss; do
    create_pair "$id"
    address_link "$id"
    route_link "$id"
    record pipes "$(pipe_in "$id")"
    pipe_config "$(pipe_in "$id")" "$mbit" "$delay" "$loss"
    record pipes "$(pipe_out "$id")"
    pipe_config "$(pipe_out "$id")" "$mbit" "$delay" "$loss"
    log "link $id: feth${id}0 10.77.$id.2, ${mbit} Mbit/s, ${delay} ms, loss $loss"
  done <"$STATE_DIR/links"
  v6_up
  write_rules
  local out token
  if [ "$DRY" = 1 ]; then
    echo "+ pfctl -E   (pf enable reference, released by 'down' with pfctl -X <token>)"
    token=dry-run
  else
    out=$(pfctl -E 2>&1)
    token=$(awk '/Token/{print $3}' <<<"$out")
    [ -n "$token" ] || log "warning: pfctl -E printed no token: $out"
  fi
  echo "$token" >"$STATE_DIR/pf-token"
  log "up: server $SERVER_IP:80 via links $(link_ids | tr '\n' ' ')"
}

cmd_via() {
  local id=${1:-}
  need_link "$id"
  local cur
  cur=$(cat "$STATE_DIR/via" 2>/dev/null)
  if [ "$cur" = "$id" ]; then
    log "server already reachable unpinned through link $id"
    return 0
  fi
  [ -n "$cur" ] && die "server already reachable unpinned through link $cur"
  echo "$id" >"$STATE_DIR/via"
  via_routes "$id"
  log "server reachable unpinned through link $id"
}

cmd_drop() {
  local id=${1:-} mode=${2:-loss} mbit delay
  need_link "$id"
  [ -f "$STATE_DIR/dropped.$id" ] && die "link $id is already dropped ($(cat "$STATE_DIR/dropped.$id")); restore it first"
  IFS=: read -r _ mbit delay _ <<<"$(link_spec "$id")"
  case $mode in
    loss)
      pipe_config "$(pipe_in "$id")" "$mbit" "$delay" 1
      pipe_config "$(pipe_out "$id")" "$mbit" "$delay" 1
      ;;
    down) run ifconfig "feth${id}0" down ;;
    gone)
      run ifconfig "feth${id}0" destroy
      run ifconfig "feth${id}1" destroy
      ;;
    *) die "drop mode must be loss, down or gone" ;;
  esac
  echo "$mode" >"$STATE_DIR/dropped.$id"
  log "link $id dropped ($mode)"
}

cmd_restore() {
  local id=${1:-} mode mbit delay loss
  need_link "$id"
  mode=$(cat "$STATE_DIR/dropped.$id" 2>/dev/null || echo loss)
  IFS=: read -r _ mbit delay loss <<<"$(link_spec "$id")"
  case $mode in
    loss)
      pipe_config "$(pipe_in "$id")" "$mbit" "$delay" "$loss"
      pipe_config "$(pipe_out "$id")" "$mbit" "$delay" "$loss"
      ;;
    down)
      run ifconfig "feth${id}0" up
      run ifconfig "feth${id}1" up
      # Setting the existing address again (SIOCAIFADDR) re-runs in_ifinit, so the interface route
      # is back even if if_up's own re-add did not happen.
      run ifconfig "feth${id}0" inet "10.77.$id.2/24" alias
      route_link "$id"
      if v6_ok; then v6_route_link "$id"; fi
      write_rules
      ;;
    gone)
      create_pair "$id"
      address_link "$id"
      route_link "$id"
      if v6_ok; then v6_link "$id"; fi
      write_rules
      ;;
  esac
  if [ "$(cat "$STATE_DIR/via" 2>/dev/null)" = "$id" ]; then via_routes "$id"; fi
  rm -f "$STATE_DIR/dropped.$id"
  log "link $id restored (after $mode)"
  # IPv4 is back either way; a link whose IPv6 did not return is reported, and the tests check it.
  [ -z "$V6_ERR" ] || log "warning: IPv6 on link $id did not come back: $V6_ERR"
}

# Leftovers netsim can recognise without its records: a feth pair carrying netsim's addresses, its
# reserved pipe numbers, its lo0 addresses and host routes through its gateways. For recovery after
# a crash; a reboot also clears all of these, as none of them persist.
sweep() {
  local id i p
  for id in 1 2 3 4 5 6 7 8; do
    for i in "feth${id}0" "feth${id}1"; do
      iface_exists "$i" || continue
      if ifconfig "$i" | grep -qE "inet 10\.77\.(${id}\.2|10${id}\.1) "; then
        try ifconfig "$i" destroy
        log "sweep: destroyed $i"
      else
        log "sweep: left $i alone: it does not carry netsim's addresses"
      fi
    done
    for p in "$(pipe_in "$id")" "$(pipe_out "$id")"; do
      if pipe_exists "$p"; then
        try dnctl pipe delete "$p"
        log "sweep: deleted dummynet pipe $p"
      fi
    done
  done
  lo0_has "$LOCAL_SERVER_IP" && try ifconfig lo0 -alias "$LOCAL_SERVER_IP"
  lo0_has "$LOCAL_SERVER_IP6" && try ifconfig lo0 inet6 "$LOCAL_SERVER_IP6" -alias
  del_via_route inet "$SERVER_IP"
  del_via_route inet6 "$SERVER_IP6"
  log "sweep: a pf enable reference netsim took cannot be told apart without its records;" \
    "'pfctl -s References' lists them, and a reboot releases them"
}

# Removes everything netsim recorded, whether or not 'up' finished. Never fails.
cmd_down() {
  local sweep_too=0 id i p a
  [ "${1:-}" = --sweep ] && sweep_too=1
  if [ -d "$STATE_DIR" ]; then
    if [ -f "$STATE_DIR/via" ]; then
      if [ "$DRY" = 1 ]; then
        try route -q -n delete -inet -host "$SERVER_IP"
        try route -q -n delete -inet6 -host "$SERVER_IP6"
      else
        del_via_route inet "$SERVER_IP"
        del_via_route inet6 "$SERVER_IP6"
      fi
    fi
    clear_anchor
    if [ -s "$STATE_DIR/pf-token" ]; then try pfctl -q -X "$(cat "$STATE_DIR/pf-token")"; fi
    for id in $(link_ids); do
      try route -q -n delete -inet default "10.77.$id.1" -ifscope "feth${id}0"
      try arp -d "10.77.$id.1" ifscope "feth${id}0"
      try route -q -n delete -inet6 default "2001:db8:77:$id::1" -ifscope "feth${id}0"
    done
    # Destroying an interface also removes its addresses, routes and neighbour entries.
    for i in $(recorded ifaces); do
      if [ "$DRY" = 1 ] || iface_exists "$i"; then try ifconfig "$i" destroy; fi
    done
    for p in $(recorded pipes); do try dnctl pipe delete "$p"; done
    for a in $(recorded lo0); do
      case $a in
        *:*) if [ "$DRY" = 1 ] || lo0_has "$a"; then try ifconfig lo0 inet6 "$a" -alias; fi ;;
        *) if [ "$DRY" = 1 ] || lo0_has "$a"; then try ifconfig lo0 -alias "$a"; fi ;;
      esac
    done
  fi
  if [ "$sweep_too" = 1 ]; then
    clear_anchor
    sweep
  fi
  rm -rf "$STATE_DIR"
  log "down"
  return 0
}

cmd_status() {
  if [ -f "$STATE_DIR/links" ]; then cat "$STATE_DIR/links"; else echo "not up"; fi
  [ -f "$STATE_DIR/v6" ] && echo "ipv6: $(cat "$STATE_DIR/v6")"
  [ -f "$STATE_DIR/via" ] && echo "via: link $(cat "$STATE_DIR/via")"
  for f in "$STATE_DIR"/dropped.*; do [ -f "$f" ] && echo "dropped: link ${f##*.} ($(cat "$f"))"; done
  ifconfig -l | tr ' ' '\n' | grep '^feth' || true
  netstat -rn -f inet | grep -E 'feth|10\.77' || true
  netstat -rn -f inet6 | grep -E 'feth|2001:db8:77' || true
  dnctl pipe show 2>/dev/null | grep -E "^0*77[0-9]{2}:" || true
}

case ${1:-} in
  up) shift && cmd_up "$@" ;;
  drop) shift && cmd_drop "$@" ;;
  restore) shift && cmd_restore "$@" ;;
  via) shift && cmd_via "$@" ;;
  down) shift && cmd_down "$@" ;;
  status) cmd_status ;;
  *) die "usage: netsim.sh up|via|drop|restore|down [--sweep]|status" ;;
esac
