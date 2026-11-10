#!/usr/bin/env bash
# Spike S1: build two fake links. Run as root.
#
#   link N client side : fethN0  10.77.N.2/24   (what the app / daemon would use as a link)
#   link N far side    : fethN1  10.77.10N.1/30 (only so IPv4 is attached to the interface)
#   gateway 10.77.N.1  : static ARP entry on fethN0 pointing at fethN1's MAC
#   "internet" server  : 198.51.100.10:80, never assigned to any interface; pf rdr on fethN1
#                        sends it to the local server 10.77.99.1:808N
#
# usage: link-up.sh replyto|asym
#   replyto: replies are forced back over the fake link with pf reply-to
#   asym   : replies return over lo0 (shaped there instead)
set -u
VARIANT=${1:-replyto}
ANCHOR=com.apple/mergelane-spike
HERE=$(cd "$(dirname "$0")" && pwd)

run() {
  echo "+ $*"
  "$@"
  local rc=$?
  [ $rc -ne 0 ] && echo "  -> exit $rc"
  return 0
}

run ifconfig lo0 alias 10.77.99.1/32

for N in 1 2; do
  C=feth${N}0
  F=feth${N}1
  run ifconfig "$C" create
  run ifconfig "$F" create
  run ifconfig "$C" peer "$F"
  run ifconfig "$C" inet "10.77.$N.2/24" up
  run ifconfig "$F" inet "10.77.10$N.1/30" up
  CMAC=$(ifconfig "$C" | awk '/ether/{print $2}')
  FMAC=$(ifconfig "$F" | awk '/ether/{print $2}')
  echo "  $C mac=$CMAC  $F mac=$FMAC"
  run arp -s "10.77.$N.1" "$FMAC" ifscope "$C"
  run route -n add -net 198.51.100.0/24 "10.77.$N.1" -ifscope "$C"
  if [ "$VARIANT" = replyto ]; then
    run arp -s "10.77.$N.2" "$CMAC" ifscope "$F"
  fi
done

# Link 1 = 20 Mbit/s, link 2 = 50 Mbit/s, 10 ms each way. Pipe 1N1 = towards the client, 1N2 = away.
# QUEUE: dummynet's default 50-slot queue is smaller than a 50 Mbit/s link's bandwidth-delay
# product, which caps TCP well below the configured rate. Override with QUEUE=... to compare.
Q=${QUEUE:-100}
run dnctl pipe 111 config bw 20Mbit/s delay 10 queue "$Q"
run dnctl pipe 112 config bw 20Mbit/s delay 10 queue "$Q"
run dnctl pipe 121 config bw 50Mbit/s delay 10 queue "$Q"
run dnctl pipe 122 config bw 50Mbit/s delay 10 queue "$Q"

RULES=$(mktemp)
{
  echo "rdr on feth11 inet proto tcp from any to 198.51.100.10 port 80 -> 10.77.99.1 port 8081"
  echo "rdr on feth21 inet proto tcp from any to 198.51.100.10 port 80 -> 10.77.99.1 port 8082"
  if [ "$VARIANT" = replyto ]; then
    echo "dummynet in quick on feth10 all pipe 111"
    echo "dummynet out quick on feth10 all pipe 112"
    echo "dummynet in quick on feth20 all pipe 121"
    echo "dummynet out quick on feth20 all pipe 122"
  else
    echo "dummynet out quick on lo0 inet proto tcp from 10.77.99.1 port 8081 to any pipe 111"
    echo "dummynet out quick on feth10 inet proto tcp all pipe 112"
    echo "dummynet out quick on lo0 inet proto tcp from 10.77.99.1 port 8082 to any pipe 121"
    echo "dummynet out quick on feth20 inet proto tcp all pipe 122"
  fi
  if [ "$VARIANT" = replyto ]; then
    echo "pass in quick on feth11 reply-to (feth11 10.77.1.2) inet proto tcp from any to 10.77.99.1 port 8081 keep state"
    echo "pass in quick on feth21 reply-to (feth21 10.77.2.2) inet proto tcp from any to 10.77.99.1 port 8082 keep state"
  fi
} >"$RULES"
echo "--- anchor $ANCHOR rules:"
cat "$RULES"
run pfctl -a "$ANCHOR" -f "$RULES"
rm -f "$RULES"

# pf enable is reference counted; keep the token so link-down.sh can release it.
TOKEN=$(pfctl -E 2>&1 | awk '/Token/{print $3}')
echo "pf token: ${TOKEN:-none}"
echo "${TOKEN:-}" >"$HERE/.pf-token"

echo "--- state"
run pfctl -a "$ANCHOR" -s nat
run pfctl -a "$ANCHOR" -s rules
run pfctl -a "$ANCHOR" -s dummynet
run dnctl pipe show
netstat -rn -f inet | grep -E '198\.51\.100|10\.77' || true
arp -an | grep 10.77 || true
