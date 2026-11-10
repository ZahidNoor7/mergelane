#!/usr/bin/env bash
# Spike S1: run the fake VPN, show what a VPN guard would see, then kill -9 it and check its routes go.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${RUNNER_TEMP:-$HERE}/fakevpn.log
(cd "$HERE/fakevpn" && go build -o "$HERE/fakevpn/fakevpn" .)
sudo "$HERE/fakevpn/fakevpn" 10.200.0.1 >"$OUT" 2>&1 &
for i in $(seq 1 20); do grep -q FAKEVPN_READY "$OUT" && break; sleep 0.5; done
cat "$OUT"
UTUN=$(awk '/FAKEVPN_READY/{print $2}' "$OUT")
PID=$(awk -F'pid=' '/FAKEVPN_READY/{print $2}' "$OUT")
echo "=== routes while the fake VPN is up"
netstat -rn -f inet | grep -E "^(0/1|128.0/1|default) " || true
echo "=== scutil --nc list (a utun from a plain process is not a NetworkExtension VPN)"
scutil --nc list
echo "=== interfaces"
ifconfig -l
echo "=== kill -9 the fake VPN"
sudo kill -9 "$PID"
sleep 1
echo "=== routes after kill -9 (0/1 and 128/1 should be gone)"
netstat -rn -f inet | grep -E "^(0/1|128.0/1) " || echo "no capture routes left"
ifconfig "$UTUN" 2>&1 | head -2
curl -sS --max-time 15 -o /dev/null -w 'connectivity after kill: HTTP %{http_code}\n' https://api.github.com/ || true
rm -f "$HERE/fakevpn/fakevpn"
exit 0
