#!/usr/bin/env bash
# Self-test of the simulated network, run inside with-netsim.sh with links 1 (slow) and 2 (fast).
# Proves: each link reaches the server and only through itself, the server counts per link, two
# links together beat either alone, a silently dropped link stops while the other continues, and
# a restored link works again.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
fail() { echo "selftest: FAIL: $*" >&2; exit 1; }
get() { node "$HERE/pinned-get.mjs" "$1" "$NETSIM_SERVER" 80 /file/512 "${2:-5}"; }
mbit() { sed -E 's/.*"mbit":([0-9.]+).*/\1/'; }

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
awk -v a="$a" -v b="$b" 'BEGIN{exit !(a>1 && b>1)}' || fail "a link carried nothing ($a, $b Mbit/s)"
awk -v a="$a" -v b="$b" 'BEGIN{exit !(b>a)}' || fail "link 2 (50 Mbit/s) is not faster than link 1 (20 Mbit/s): $b vs $a"

echo "== the server counted each link separately"
stats=$(curl -fsS "$NETSIM_CONTROL/stats")
echo "$stats"
grep -q '"1":{"bytes":[1-9]' <<<"$stats" || fail "no bytes counted on link 1"
grep -q '"2":{"bytes":[1-9]' <<<"$stats" || fail "no bytes counted on link 2"
grep -q '10.77.1.2' <<<"$stats" || fail "link 1's client address not seen"
grep -q '10.77.2.2' <<<"$stats" || fail "link 2's client address not seen"

echo "== both links at once beat the faster one alone"
get feth10 >"${TMPDIR:-/tmp}/netsim-a" &
get feth20 >"${TMPDIR:-/tmp}/netsim-b"
wait
both=$(awk -v a="$(mbit <"${TMPDIR:-/tmp}/netsim-a")" -v b="$(mbit <"${TMPDIR:-/tmp}/netsim-b")" 'BEGIN{print a+b}')
rm -f "${TMPDIR:-/tmp}/netsim-a" "${TMPDIR:-/tmp}/netsim-b"
echo "both: $both Mbit/s, faster alone: $b Mbit/s"
awk -v t="$both" -v b="$b" 'BEGIN{exit !(t>b*1.1)}' || fail "two links ($both) not above the faster alone ($b)"

echo "== silent loss on link 2: it stops, link 1 continues"
sudo bash "$HERE/netsim.sh" drop 2 loss
lost=$(get feth20 3) && echo "$lost"
kept=$(get feth10 3) && echo "$kept"
awk -v x="$(mbit <<<"$lost")" 'BEGIN{exit !(x<0.5)}' || fail "a dropped link still carried traffic"
awk -v x="$(mbit <<<"$kept")" 'BEGIN{exit !(x>1)}' || fail "the other link stopped too"

echo "== restore link 2"
sudo bash "$HERE/netsim.sh" restore 2
back=$(get feth20 3) && echo "$back"
awk -v x="$(mbit <<<"$back")" 'BEGIN{exit !(x>1)}' || fail "the restored link carries nothing"

echo "selftest: PASS"
