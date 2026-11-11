#!/usr/bin/env bash
# Self-test of the simulated network, run inside with-netsim.sh with links 1 (slow) and 2 (fast).
# Proves: each link reaches the server and only through itself, the server counts per link, two
# links together beat either alone, a silently dropped link stops while the other continues, a
# restored link works again, a link taken down with 'ifconfig down' or destroyed outright carries
# traffic again after 'netsim.sh restore', and the same server answers over IPv6 on each link.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FAILED=0
fail() {
  echo "selftest: FAIL: $*" >&2
  FAILED=$((FAILED + 1))
}
get() { node "$HERE/pinned-get.mjs" "$1" "${3:-$NETSIM_SERVER}" 80 /file/512 "${2:-5}" 2>&1; }
# Mbit/s from pinned-get's JSON; 0 when it printed none (the interface is gone, say).
mbit() { sed -nE 's/.*"mbit":([0-9.]+).*/\1/p' | tail -1 | grep . || echo 0; }
above() { awk -v x="$1" -v min="$2" 'BEGIN{exit !(x>min)}'; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for id in $NETSIM_LINKS; do
  who=$(curl -fsS --max-time 5 --interface "feth${id}0" "http://$NETSIM_SERVER/whoami" 2>&1) &&
    echo "curl --interface feth${id}0: $who" || echo "curl --interface feth${id}0 failed (informational): $who"
done

echo "== an unpinned connection cannot reach the server (scoped routes only)"
if curl -fsS --max-time 3 "http://$NETSIM_SERVER/whoami" >/dev/null 2>&1; then
  fail "the server was reachable without pinning"
fi

echo "== each link alone"
one=$(get feth10) && echo "$one"
two=$(get feth20) && echo "$two"
a=$(mbit <<<"$one")
b=$(mbit <<<"$two")
if ! above "$a" 1 || ! above "$b" 1; then fail "a link carried nothing ($a, $b Mbit/s)"; fi
above "$b" "$a" || fail "link 2 (50 Mbit/s) is not faster than link 1 (20 Mbit/s): $b vs $a"

echo "== the server counted each link separately"
stats=$(curl -fsS "$NETSIM_CONTROL/stats")
echo "$stats"
grep -q '"1":{"bytes":[1-9]' <<<"$stats" || fail "no bytes counted on link 1"
grep -q '"2":{"bytes":[1-9]' <<<"$stats" || fail "no bytes counted on link 2"
grep -q '10.77.1.2' <<<"$stats" || fail "link 1's client address not seen"
grep -q '10.77.2.2' <<<"$stats" || fail "link 2's client address not seen"

echo "== both links at once beat the faster one alone"
get feth10 >"$TMP/a" &
get feth20 >"$TMP/b"
wait
both=$(awk -v a="$(mbit <"$TMP/a")" -v b="$(mbit <"$TMP/b")" 'BEGIN{print a+b}')
echo "both: $both Mbit/s, faster alone: $b Mbit/s"
awk -v t="$both" -v b="$b" 'BEGIN{exit !(t>b*1.1)}' || fail "two links ($both) not above the faster alone ($b)"

echo "== IPv6: each link reaches [${NETSIM_SERVER6:-none}] only through itself"
if [ -z "${NETSIM_SERVER6:-}" ]; then
  fail "the simulated links have no IPv6: ${NETSIM_V6_ERROR:-unknown reason}"
else
  for id in $NETSIM_LINKS; do
    out=$(get "feth${id}0" 3 "$NETSIM_SERVER6") && echo "$out"
    above "$(mbit <<<"$out")" 1 || fail "IPv6 over link $id carried nothing"
  done
  stats=$(curl -fsS "$NETSIM_CONTROL/stats")
  grep -q '2001:db8:77:1::2' <<<"$stats" || fail "link 1's IPv6 client address not seen: $stats"
  grep -q '2001:db8:77:2::2' <<<"$stats" || fail "link 2's IPv6 client address not seen: $stats"
  if curl -fsS -g --max-time 3 "http://[$NETSIM_SERVER6]/whoami" >/dev/null 2>&1; then
    fail "the IPv6 server was reachable without pinning"
  fi
fi

echo "== silent loss on link 2: it stops, link 1 continues"
sudo bash "$HERE/netsim.sh" drop 2 loss
lost=$(get feth20 3) && echo "$lost"
kept=$(get feth10 3) && echo "$kept"
above "$(mbit <<<"$lost")" 0.5 && fail "a dropped link still carried traffic"
above "$(mbit <<<"$kept")" 1 || fail "the other link stopped too"

echo "== restore link 2"
sudo bash "$HERE/netsim.sh" restore 2
back=$(get feth20 3) && echo "$back"
above "$(mbit <<<"$back")" 1 || fail "the restored link carries nothing"

# ADR-0015 found that a link taken down and up again stayed dead. 'restore' now re-adds what the
# kernel deleted on the way down (the ARP entry, the scoped default and any host route).
echo "== link 2 taken down (ifconfig down), then restored"
sudo bash "$HERE/netsim.sh" drop 2 down
lost=$(get feth20 3) && echo "$lost"
above "$(mbit <<<"$lost")" 0.5 && fail "a link that is down still carried traffic"
above "$(mbit <<<"$(get feth10 3)")" 1 || fail "link 1 stopped while link 2 was down"
sudo bash "$HERE/netsim.sh" restore 2
netstat -rn -f inet | grep -E 'feth20' || true
back=$(get feth20 3) && echo "$back"
above "$(mbit <<<"$back")" 1 || fail "link 2 carries nothing after ifconfig down and restore"
if [ -n "${NETSIM_SERVER6:-}" ]; then
  back6=$(get feth20 3 "$NETSIM_SERVER6") && echo "$back6"
  above "$(mbit <<<"$back6")" 1 || fail "link 2 carries no IPv6 after ifconfig down and restore"
fi

echo "== link 2's feth pair destroyed, then created again"
index_of() { netstat -rn -f inet | awk -v i="$1" '$4 == i && $2 ~ /^link#/ {print $2; exit}'; }
old_index=$(index_of feth20)
sudo bash "$HERE/netsim.sh" drop 2 gone
ifconfig feth20 >/dev/null 2>&1 && fail "feth20 still exists after drop gone"
lost=$(get feth20 2) && echo "$lost"
above "$(mbit <<<"$lost")" 0.5 && fail "a destroyed link carried traffic"
sudo bash "$HERE/netsim.sh" restore 2
echo "feth20 interface route: $old_index before, $(index_of feth20) after"
back=$(get feth20 3) && echo "$back"
above "$(mbit <<<"$back")" 1 || fail "link 2 carries nothing after it was created again"
if [ -n "${NETSIM_SERVER6:-}" ]; then
  back6=$(get feth20 3 "$NETSIM_SERVER6") && echo "$back6"
  above "$(mbit <<<"$back6")" 1 || fail "link 2 carries no IPv6 after it was created again"
fi

if [ "$FAILED" -eq 0 ]; then echo "selftest: PASS"; else echo "selftest: $FAILED FAILED"; fi
exit "$FAILED"
