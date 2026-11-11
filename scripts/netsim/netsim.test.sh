#!/usr/bin/env bash
# Tests for netsim.sh without root: every case runs in dry-run mode (NETSIM_DRY_RUN=1) against stub
# ifconfig, dnctl, pfctl, route, arp, ndp and netstat, which log each call and describe a Mac whose
# state each case sets. Proves the argument checks, the refusals before anything changes, what is
# recorded and what 'down' removes, the per-mode drop/restore sequences, the generated pf rules
# (parsed by the real pfctl -n), and that a dry run never calls a command that changes the system.
# usage: bash scripts/netsim/netsim.test.sh
#
# shellcheck disable=SC2016 # stub bodies are literal scripts, expanded when the stub runs
# shellcheck disable=SC2015 # ok() always returns 0, so "check && ok || bad" never fails an ok
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NETSIM="$HERE/netsim.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
passed=0
failed=0

# --- stubs -----------------------------------------------------------------------------------
mkdir -p "$T/bin"
stub() { # <name> <body>
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG"\n%s\n' "$1" "$2" >"$T/bin/$1"
  chmod +x "$T/bin/$1"
}
# ifconfig: STUB_IFACES lists interfaces that exist; STUB_ADDR_<name> gives one's IPv4 address;
# STUB_LO0 holds lo0's extra address lines.
stub ifconfig '
case "${1:-}" in
  -l) echo "lo0 en0 ${STUB_IFACES:-}"; exit 0 ;;
  lo0) printf "lo0: flags=8049<UP,LOOPBACK>\n\tinet 127.0.0.1 netmask 0xff000000\n%b" "${STUB_LO0:-}"; exit 0 ;;
esac
for i in ${STUB_IFACES:-}; do
  if [ "$i" = "$1" ]; then
    var="STUB_ADDR_$1"
    printf "%s: flags=8863<UP>\n\tether 0a:00:00:00:00:%s\n\tinet %s netmask 0xffffff00\n" "$1" "${1#feth}" "${!var:-192.0.2.1}"
    exit 0
  fi
done
exit 1'
stub dnctl '[ "${1:-} ${2:-}" = "pipe show" ] && printf "%b" "${STUB_PIPES:-}"; exit 0'
stub pfctl 'case "$*" in *"-s rules"*) printf "%b" "${STUB_ANCHOR:-}" ;; esac; exit 0'
stub route '[ "${2:-}" = get ] || [ "${3:-}" = get ] && echo "    gateway: ${STUB_VIA_GW:-192.168.1.1}"; exit 0'
stub arp 'exit 0'
stub ndp 'exit 0'
stub netstat 'echo "Routing tables"; exit 0'

# netsim <args...>: runs netsim.sh in a dry run against the stubs, with state in $T/st.
netsim() {
  : >"$T/calls"
  env PATH="$T/bin:$PATH" STUB_LOG="$T/calls" NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$T/st" bash "$NETSIM" "$@" 2>&1
}
# The same without the dry-run switch, as a user who is not root.
netsim_not_root() {
  : >"$T/calls"
  env PATH="$T/bin:$PATH" STUB_LOG="$T/calls" bash "$NETSIM" "$@" 2>&1
}
# A dry run may query the system, never change it.
mutating_calls() {
  grep -E ' (create|destroy|alias|-alias|peer|up|down|delete|add|config)( |$)|^pfctl .*(-f|-F|-E|-X)|^arp .*-[sd]|^ndp .*-[sd]' "$T/calls" |
    grep -vE '^(route .* get|ifconfig -l)' || true
}

ok() {
  echo "ok   $1"
  passed=$((passed + 1))
}
bad() {
  echo "FAIL $1"$'\n'"${2:-}"
  failed=$((failed + 1))
}
# expect <name> <want exit> <output must contain, or ""> <command...>
expect() {
  local name=$1 want=$2 msg=$3 out rc
  shift 3
  out=$("$@")
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    bad "$name: exit $rc, want $want" "$out"
  elif [ -n "$msg" ] && ! grep -qF -- "$msg" <<<"$out"; then
    bad "$name: output lacks '$msg'" "$out"
  elif [ -n "$(mutating_calls)" ]; then
    bad "$name: the dry run called a command that changes the system" "$(mutating_calls)"
  else
    ok "$name"
  fi
  LAST=$out
}
has() { # <name> <text that must be in $LAST>
  if grep -qF -- "$2" <<<"$LAST"; then ok "$1"; else bad "$1: lacks '$2'" "$LAST"; fi
}
lacks() {
  if grep -qF -- "$2" <<<"$LAST"; then bad "$1: has '$2'" "$LAST"; else ok "$1"; fi
}
reset() {
  rm -rf "$T/st"
  unset STUB_IFACES STUB_LO0 STUB_PIPES STUB_ANCHOR STUB_VIA_GW STUB_ADDR_feth10 STUB_ADDR_feth20
}

# --- argument checks -------------------------------------------------------------------------
reset
expect "not root and not a dry run: refused" 1 "run as root" netsim_not_root up 1:20:10:0
expect "no command: usage" 1 "usage: netsim.sh up|via|drop|restore|down" netsim
expect "up without links: usage" 1 "usage: netsim.sh up" netsim up
expect "link id 9 refused" 1 "link id must be 1-8, got '9'" netsim up 9:20:10:0
expect "bad rate refused" 1 "bad link spec '1:fast:10:0'" netsim up 1:fast:10:0
expect "bad loss refused" 1 "bad link spec '1:20:10:2'" netsim up 1:20:10:2
expect "a link given twice refused" 1 "link 1 given twice" netsim up 1:20:10:0 1:50:10:0
[ ! -e "$T/st" ] && ok "a refused up records nothing" || bad "a refused up left state behind" "$(ls -R "$T/st")"

# --- refusals before anything changes --------------------------------------------------------
reset
export STUB_IFACES="feth20"
expect "an existing feth20 is not taken over" 1 "feth20 already exists and netsim did not create it" netsim up 1:20:10:0 2:50:10:0
[ ! -e "$T/st" ] && ok "... and nothing was recorded" || bad "state recorded despite the refusal"
reset
export STUB_PIPES='07721:  1.000 Mbit/s\n'
expect "an existing pipe 7721 is not reconfigured" 1 "dummynet pipe 7721 already exists" netsim up 1:20:10:0 2:50:10:0
reset
export STUB_LO0='\tinet 10.77.99.1 netmask 0xffffffff\n'
expect "lo0 already holding 10.77.99.1 is refused" 1 "lo0 already has 10.77.99.1" netsim up 1:20:10:0
reset
export STUB_LO0='\tinet6 2001:db8:77:99::1 prefixlen 128\n'
expect "lo0 already holding the IPv6 address is refused" 1 "lo0 already has 2001:db8:77:99::1" netsim up 1:20:10:0
reset
export STUB_ANCHOR='rdr on feth11 inet proto tcp from any to 198.51.100.10 port = 80 -> 10.77.99.1 port 8081\n'
expect "an anchor that already has rules is refused" 1 "already has rules" netsim up 1:20:10:0

# --- up --------------------------------------------------------------------------------------
reset
expect "up with two links" 0 "netsim: up: server 198.51.100.10:80 via links 1 2" netsim up 1:20:10:0 2:50:10:0
UP=$LAST
has "creates the feth pairs" "+ ifconfig feth10 create"
has "peers them" "+ ifconfig feth20 peer feth21"
has "static ARP for the gateway, scoped" "+ arp -s 10.77.2.1 <mac-of-feth21> ifscope feth20"
has "scoped default route" "+ route -q -n add -inet default 10.77.1.1 -ifscope feth10"
has "shapes with pipes 7711/7712" "+ dnctl pipe 7712 config bw 20Mbit/s delay 10 plr 0 queue 100"
has "IPv6 address on the link" "+ ifconfig feth10 inet6 2001:db8:77:1::2 prefixlen 64 alias"
has "IPv6 gateway as a static NDP entry" "+ ndp -s 2001:db8:77:2::1 <mac-of-feth21>"
has "scoped IPv6 default" "+ route -q -n add -inet6 default 2001:db8:77:2::1 -ifscope feth20"
has "IPv6 rdr rule" "rdr on feth21 inet6 proto tcp from any to 2001:db8:198:51:100::10 port 80 -> 2001:db8:77:99::1 port 8082"
has "pf enabled with a reference" "+ pfctl -E"
lacks "never flushes everything" "-F all"
lacks "never touches the main ruleset" "pfctl -f"
[ "$(cat "$T/st/ifaces" 2>/dev/null | tr '\n' ' ')" = "feth10 feth11 feth20 feth21 " ] && ok "records the interfaces" || bad "ifaces record" "$(cat "$T/st/ifaces")"
[ "$(cat "$T/st/pipes" 2>/dev/null | tr '\n' ' ')" = "7711 7712 7721 7722 " ] && ok "records the pipes" || bad "pipes record" "$(cat "$T/st/pipes")"
[ "$(cat "$T/st/lo0" 2>/dev/null | tr '\n' ' ')" = "10.77.99.1 2001:db8:77:99::1 " ] && ok "records the lo0 addresses" || bad "lo0 record"
[ "$(cat "$T/st/v6")" = ok ] && ok "records IPv6 as available" || bad "v6 record" "$(cat "$T/st/v6")"
# Recording happens before creating: each name appears in the record before its create command.
grep -n 'feth10 create' <<<"$UP" >/dev/null && ok "creates only after the refusal checks passed" || bad "no create line"

rules=$(sed -n 's/^  | //p' <<<"$UP")
printf '%s\n' "$rules" >"$T/rules"
if /sbin/pfctl -q -n -a com.apple/mergelane-netsim -f "$T/rules" >"$T/pfctl.out" 2>&1; then
  ok "the generated rules parse (pfctl -n, nothing loaded)"
else
  bad "pfctl -n rejected the rules" "$(cat "$T/pfctl.out")"$'\n'"$rules"
fi
[ "$(wc -l <"$T/rules" | tr -d ' ')" = 10 ] && ok "ten rules for two links, IPv4 and IPv6" || bad "rule count" "$rules"

expect "up again is refused while up" 1 "already up" netsim up 1:20:10:0

# --- via -------------------------------------------------------------------------------------
expect "via 1" 0 "server reachable unpinned through link 1" netsim via 1
has "host route through link 1" "+ route -q -n add -inet -host 198.51.100.10 10.77.1.1"
has "and over IPv6" "+ route -q -n add -inet6 -host 2001:db8:198:51:100::10 2001:db8:77:1::1"
expect "via 1 again is harmless (two Playwright workers)" 0 "already reachable unpinned through link 1" netsim via 1
expect "via 2 while via 1 is refused" 1 "already reachable unpinned through link 1" netsim via 2
expect "via an unknown link is refused" 1 "no link 3" netsim via 3
expect "via a bad id is refused" 1 "link id must be 1-8" netsim via x

# --- drop and restore ------------------------------------------------------------------------
expect "drop 2 loss" 0 "link 2 dropped (loss)" netsim drop 2 loss
has "loss sets plr 1" "+ dnctl pipe 7721 config bw 50Mbit/s delay 10 plr 1 queue 100"
expect "a second drop is refused until restored" 1 "already dropped (loss); restore it first" netsim drop 2 down
expect "restore 2 after loss" 0 "link 2 restored (after loss)" netsim restore 2
has "restores plr 0" "+ dnctl pipe 7722 config bw 50Mbit/s delay 10 plr 0 queue 100"
[ ! -e "$T/st/dropped.2" ] && ok "restore clears the drop record" || bad "dropped.2 left"

expect "drop 1 down" 0 "link 1 dropped (down)" netsim drop 1 down
has "takes the interface down" "+ ifconfig feth10 down"
expect "restore 1 after down" 0 "link 1 restored (after down)" netsim restore 1
has "brings it up" "+ ifconfig feth10 up"
has "re-sets the address so the interface route is back" "+ ifconfig feth10 inet 10.77.1.2/24 alias"
has "re-adds the ARP entry the kernel deleted" "+ arp -s 10.77.1.1 <mac-of-feth11> ifscope feth10"
has "re-adds the scoped default" "+ route -q -n add -inet default 10.77.1.1 -ifscope feth10"
has "re-adds the IPv6 default" "+ route -q -n add -inet6 default 2001:db8:77:1::1 -ifscope feth10"
has "re-adds the via route of that link" "+ route -q -n add -inet -host 198.51.100.10 10.77.1.1"

expect "drop 2 gone" 0 "link 2 dropped (gone)" netsim drop 2 gone
has "destroys both ends" "+ ifconfig feth21 destroy"
expect "restore 2 after gone" 0 "link 2 restored (after gone)" netsim restore 2
has "creates the pair again" "+ ifconfig feth20 create"
has "addresses it again" "+ ifconfig feth20 inet 10.77.2.2/24 up"
has "its IPv6 again" "+ ifconfig feth20 inet6 2001:db8:77:2::2 prefixlen 64 alias"
has "reloads the rules" "+ pfctl -q -a com.apple/mergelane-netsim -f <rules>"
lacks "keeps the pipes (not re-created)" "+ dnctl pipe 7721 config"
[ "$(grep -c feth20 "$T/st/ifaces")" = 1 ] && ok "a re-created interface is recorded once" || bad "duplicate records" "$(cat "$T/st/ifaces")"

expect "a bad drop mode is refused" 1 "drop mode must be loss, down or gone" netsim drop 1 sideways
expect "restore without a drop re-applies the shaping" 0 "link 1 restored (after loss)" netsim restore 1
expect "status reads the state" 0 "ipv6: ok" netsim status
has "status shows via" "via: link 1"

# --- down ------------------------------------------------------------------------------------
expect "down" 0 "netsim: down" netsim down
has "empties only netsim's anchor" "+ pfctl -q -a com.apple/mergelane-netsim -F rules"
has "releases its pf reference" "+ pfctl -q -X dry-run"
has "destroys the recorded interfaces" "+ ifconfig feth21 destroy"
has "deletes the recorded pipes" "+ dnctl pipe delete 7722"
has "removes its lo0 addresses" "+ ifconfig lo0 inet6 2001:db8:77:99::1 -alias"
has "removes the via route" "+ route -q -n delete -inet -host 198.51.100.10"
lacks "never flushes everything" "-F all"
lacks "deletes no pipe it did not record" "pipe delete 7731"
[ ! -e "$T/st" ] && ok "down removes the state directory" || bad "state left after down"
expect "down twice is harmless" 0 "netsim: down" netsim down
lacks "... and touches nothing without records" "+ ifconfig"

# --- down --sweep: recognises netsim's leftovers without records -----------------------------
reset
export STUB_IFACES="feth10 feth20"
export STUB_ADDR_feth10=10.77.1.2
export STUB_ADDR_feth20=192.168.50.2
export STUB_PIPES='07711:  20.000 Mbit/s\n00042:  1.000 Mbit/s\n'
export STUB_LO0='\tinet 10.77.99.1 netmask 0xffffffff\n'
export STUB_VIA_GW=10.77.1.1
expect "down --sweep" 0 "sweep: destroyed feth10" netsim down --sweep
has "a feth carrying netsim's address goes" "+ ifconfig feth10 destroy"
has "a feth without it is left alone" "sweep: left feth20 alone"
lacks "... and not destroyed" "ifconfig feth20 destroy"
has "netsim's pipe goes" "+ dnctl pipe delete 7711"
lacks "another pipe stays" "pipe delete 42"
has "its lo0 address goes" "+ ifconfig lo0 -alias 10.77.99.1"
has "a host route through its gateway goes" "+ route -q -n delete -inet -host 198.51.100.10"
reset
export STUB_VIA_GW=192.168.1.1
expect "down --sweep with nothing of netsim's" 0 "netsim: down" netsim down --sweep
lacks "leaves a host route through someone else's gateway" "delete -inet -host 198.51.100.10"
lacks "destroys nothing" "destroy"

echo
echo "netsim.test.sh: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
