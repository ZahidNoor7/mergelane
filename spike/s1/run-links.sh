#!/usr/bin/env bash
# Spike S1: exercise the fake links for one variant. Runs as the runner user; uses sudo for setup.
# usage: run-links.sh replyto|asym
set -u
VARIANT=$1
HERE=$(cd "$(dirname "$0")" && pwd)
LOGS=${RUNNER_TEMP:-$HERE}/s1-$VARIANT
mkdir -p "$LOGS"

echo "################ variant: $VARIANT"
sudo QUEUE="${QUEUE:-100}" bash "$HERE/link-up.sh" "$VARIANT"

node "$HERE/server.mjs" 10.77.99.1 8081 512 >"$LOGS/server-8081.log" 2>&1 &
S1=$!
node "$HERE/server.mjs" 10.77.99.1 8082 512 >"$LOGS/server-8082.log" 2>&1 &
S2=$!
sudo tcpdump -ni feth11 -c 40 -w "$LOGS/feth11.pcap" tcp >/dev/null 2>&1 &
sudo tcpdump -ni feth10 -c 40 -w "$LOGS/feth10.pcap" tcp >/dev/null 2>&1 &
sleep 1

echo "=== T2a: pinned socket on feth10 only (expect ~20 Mbit/s)"
node "$HERE/bind.mjs" feth10 198.51.100.10 80 8
echo "=== T2b: pinned socket on feth20 only (expect ~50 Mbit/s)"
node "$HERE/bind.mjs" feth20 198.51.100.10 80 8
echo "=== T2c: both links at once (expect ~70 Mbit/s total)"
node "$HERE/bind.mjs" feth10 198.51.100.10 80 8 feth20
echo "=== T2d: unpinned socket (expect failure: 198.51.100.0/24 is only reachable through scoped routes)"
node "$HERE/bind.mjs" - 198.51.100.10 80 3

echo "=== T2e: drop link 2 with ifconfig down while downloading on both"
( sleep 3; sudo ifconfig feth20 down; echo "  feth20 down at +3s" ) &
node "$HERE/bind.mjs" feth10 198.51.100.10 80 8 feth20
sudo ifconfig feth20 up
echo "  routes and ARP on feth20 after it came back up:"
netstat -rn -f inet | grep feth20 || echo "  (no feth20 routes)"
arp -an -i feth20 || true
echo "  re-adding the scoped route and gateway ARP for link 2 (what recovery has to do)"
sudo arp -s 10.77.2.1 "$(ifconfig feth21 | awk '/ether/{print $2}')" ifscope feth20
sudo route -n add -net 198.51.100.0/24 10.77.2.1 -ifscope feth20
node "$HERE/bind.mjs" feth20 198.51.100.10 80 3

echo "=== T2f: silent loss on link 2 (plr 1) while downloading on both"
( sleep 3; sudo dnctl pipe 121 config bw 50Mbit/s delay 10 plr 1; sudo dnctl pipe 122 config bw 50Mbit/s delay 10 plr 1; echo "  pipes 121/122 plr 1 at +3s" ) &
node "$HERE/bind.mjs" feth10 198.51.100.10 80 8 feth20

echo "=== dummynet counters"
sudo dnctl pipe show
echo "=== server logs (source addresses seen)"
head -5 "$LOGS/server-8081.log" "$LOGS/server-8082.log"
echo "=== packets seen on feth10 / feth11"
sudo tcpdump -nr "$LOGS/feth10.pcap" 2>/dev/null | head -12
sudo tcpdump -nr "$LOGS/feth11.pcap" 2>/dev/null | head -12

kill "$S1" "$S2" 2>/dev/null
sudo pkill -f "tcpdump -ni feth" 2>/dev/null
sudo bash "$HERE/link-down.sh"
exit 0
