#!/usr/bin/env bash
# Spike S1: remove everything link-up.sh created. Safe to run more than once. Run as root.
set -u
ANCHOR=com.apple/mergelane-spike
HERE=$(cd "$(dirname "$0")" && pwd)

pfctl -a "$ANCHOR" -F all 2>/dev/null
if [ -s "$HERE/.pf-token" ]; then
  pfctl -X "$(cat "$HERE/.pf-token")" 2>/dev/null
  rm -f "$HERE/.pf-token"
fi
for P in 111 112 121 122; do dnctl pipe delete "$P" 2>/dev/null; done
for N in 1 2; do
  route -n delete -net 198.51.100.0/24 "10.77.$N.1" -ifscope "feth${N}0" >/dev/null 2>&1
  arp -d "10.77.$N.1" ifscope "feth${N}0" >/dev/null 2>&1
  arp -d "10.77.$N.2" ifscope "feth${N}1" >/dev/null 2>&1
  ifconfig "feth${N}0" destroy 2>/dev/null
  ifconfig "feth${N}1" destroy 2>/dev/null
done
ifconfig lo0 -alias 10.77.99.1 2>/dev/null

echo "--- leftovers (should be empty)"
ifconfig -l | tr ' ' '\n' | grep '^feth' || true
netstat -rn -f inet | grep -E '198\.51\.100|10\.77' || true
dnctl pipe show 2>/dev/null | grep -E '^0?1[12][12]:' || true
pfctl -a "$ANCHOR" -s rules 2>/dev/null || true
exit 0
