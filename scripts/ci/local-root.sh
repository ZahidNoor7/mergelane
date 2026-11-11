#!/usr/bin/env bash
# Runs Mergelane's root-only test suites on the owner's own Mac instead of CI (CI is paused,
# docs/DECISIONS.md ADR-0020): the simulated-network self-test (CI job netsim), the daemon
# acceptance tests (daemon-acceptance), the app's downloads over simulated links (app-acceptance),
# and the daemon job's one root step: the Go engine tests that need lo0 aliases 127.0.0.2 and .3.
#
# In order:
#   1. Checks, without root, that it is safe to start. Refuses on an active VPN, a Mergelane test
#      already running, Mergelane.app or Playwright running, missing tools, netsim's addresses in
#      use, or a backup left by an earlier run. Nothing is changed before this passes.
#   2. Asks for your password once (sudo -v) and keeps sudo's timestamp fresh until it ends.
#   3. Pauses the installed Mergelane helper: records its state, backs up its plist, binary and
#      settings to /var/db/mergelane-local-ci (root only, survives a reboot), turns merging off
#      through its socket, and boots it out of launchd. A root watchdog restores it if this script
#      is killed or its terminal closed.
#   4. Runs the suites. While a test daemon merges over the two simulated links only, this Mac's
#      real internet does not work (stretches of seconds to about a minute, in the daemon suite).
#   5. Always (success, failure, Ctrl-C, closed terminal): removes what the tests left, restores
#      the helper byte for byte, turns merging back on if it was on, and verifies all of it.
#
# usage: scripts/ci/local-root.sh [--only go,netsim,daemon,app] [--no-build] [--yes] [--dry-run]
#        scripts/ci/local-root.sh --restore     (or --cleanup) undo everything after a crash
#        scripts/ci/local-root.sh --help
# Everything goes to local-ci-logs/root-<time>.log (gitignored), with a PASS/FAIL table at the end.
#
# --dry-run runs the read-only checks, then prints every command that needs root, in order, without
# running any; it never calls sudo. Only in a dry run do the LOCAL_ROOT_* variables below move the
# paths it looks at (for its tests).
set -uo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
SELF="$REPO/scripts/ci/local-root.sh"
LIB="$REPO/scripts/ci/local-root-lib.mjs"
NETSIM="$REPO/scripts/netsim/netsim.sh"
WITH_NETSIM="$REPO/scripts/netsim/with-netsim.sh"
LABEL=io.github.zahidnoor7.mergelane.daemon
ANCHOR=com.apple/mergelane-netsim
SPECS="1:20:10:0 2:50:10:0" # links 1 (20 Mbit/s) and 2 (50 Mbit/s), as in ci.yml
read -r -a SPEC_LIST <<<"$SPECS"
TEST_BIN=/tmp/mergelane-acceptance-bin # daemon.sh builds the test daemon here (fixed path, as in CI)

MODE=run DRY=0 ONLY="go,netsim,daemon,app" BUILD=1 YES=0 WATCH_PID="" WATCH_LOG="" WATCH_PGID=""
usage() { sed -n '2,/^set -uo/p' "$SELF" | sed -e '/^set -uo/d' -e 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --only) ONLY=${2:-} && shift ;;
    --only=*) ONLY=${1#*=} ;;
    --no-build) BUILD=0 ;;
    --yes | -y) YES=1 ;;
    --restore | --cleanup) MODE=restore ;;
    --watchdog) MODE=watchdog WATCH_PID=${2:-} WATCH_LOG=${3:-} WATCH_PGID=${4:-} && shift 3 ;; # internal, as root
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "local-root: unknown argument '$1' (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
for s in ${ONLY//,/ }; do
  case $s in go | netsim | daemon | app) ;; *)
    echo "local-root: --only takes go, netsim, daemon and app, got '$s'" >&2
    exit 2
    ;;
  esac
done
[ -n "${ONLY//,/}" ] || {
  echo "local-root: --only needs at least one suite" >&2
  exit 2
}
selected() { [[ ",$ONLY," == *",$1,"* ]]; }

# Fixed paths. A dry run (which never runs sudo) lets its tests point them elsewhere.
PLIST=/Library/LaunchDaemons/$LABEL.plist
HELPER=/Library/PrivilegedHelperTools/$LABEL
SUPPORT="/Library/Application Support/Mergelane"
BACKUP=/var/db/mergelane-local-ci
LOG_DIR="$REPO/local-ci-logs"
if [ "$DRY" = 1 ]; then
  PLIST=${LOCAL_ROOT_PLIST:-$PLIST}
  HELPER=${LOCAL_ROOT_HELPER:-$HELPER}
  SUPPORT=${LOCAL_ROOT_SUPPORT:-$SUPPORT}
  BACKUP=${LOCAL_ROOT_BACKUP:-$BACKUP}
  LOG_DIR=${LOCAL_ROOT_LOG_DIR:-$LOG_DIR}
fi
HELPER_STATE="$SUPPORT/daemon"

say() { printf '%s\n' "$*"; }
step() { printf '\n=== %s %s\n' "$(date +%H:%M:%S)" "$*"; }
note() { printf '    %s\n' "$*"; }
indent() { sed 's/^/    /'; }

# priv: a command that needs root. Printed, never run, in a dry run.
priv() {
  if [ "$DRY" = 1 ]; then
    say "  [root] $*"
    return 0
  fi
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi
}
# The same with its output and errors hidden, except that a dry run still prints it.
priv_quiet() { if [ "$DRY" = 1 ]; then priv "$@"; else priv "$@" >/dev/null 2>&1; fi; }

# ---------------------------------------------------------------------------------------------
# The helper's state, as manifest lines (key=value). Works as the owner or as root.

sha_of() { if [ -f "$1" ]; then shasum -a 256 "$1" | cut -d' ' -f1; fi; }
loaded() { launchctl print "system/$LABEL" >/dev/null 2>&1; }
merge_state() {
  local out
  [ -x "$HELPER" ] || {
    echo none
    return
  }
  loaded || {
    echo stopped
    return
  }
  if out=$("$HELPER" status 2>&1); then
    sed -nE 's/^system merge: ([a-z]+).*/\1/p' <<<"$out" | head -1
  else
    echo unreachable
  fi
}
helper_facts() {
  local p=absent b=absent
  [ -e "$PLIST" ] && p=present
  [ -e "$HELPER" ] && b=present
  echo "plist=$p"
  echo "plist_sha=$(sha_of "$PLIST")"
  echo "binary=$b"
  echo "binary_sha=$(sha_of "$HELPER")"
  echo "state=$([ -d "$HELPER_STATE" ] && echo present || echo absent)"
  echo "support=$([ -d "$SUPPORT" ] && echo present || echo absent)"
  echo "loaded=$(loaded && echo yes || echo no)"
  echo "merge=$(merge_state)"
  echo "disabled=$(launchctl print-disabled system 2>/dev/null | awk -v l="\"$LABEL\"" '$1 == l {print $3}')"
}
fact() { sed -n "s/^$1=//p" "$2" | head -1; }

# ---------------------------------------------------------------------------------------------
# Logging and results

RESULTS=""
record() { echo "$1|$2|$3|${4:-}" >>"$RESULTS"; } # name, PASS/FAIL/SKIP, seconds, note
setup_log() {
  mkdir -p "$LOG_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  LOG="$LOG_DIR/root-$STAMP.log"
  RUN_TMP=$(mktemp -d -t mergelane-local-root)
  RESULTS="$RUN_TMP/results"
  : >"$RESULTS"
  # A closed pipe must not kill the restore: tee ignores Ctrl-C, and a failed write is not fatal.
  trap '' PIPE
  exec > >(
    trap '' INT TERM HUP
    exec tee -a "$LOG"
  ) 2>&1
  say "local-root: log $LOG"
  say "local-root: $(date), $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null), repo $REPO"
}

# ---------------------------------------------------------------------------------------------
# 1. Read-only checks

REFUSALS=""
refuse() { REFUSALS="$REFUSALS$*"$'\n'; }
# Processes matching the extended regex $1 (pgrep(1)), other than this script's own: its $(...)
# subshells carry its command line too, so they are told apart by process group.
others_running() {
  local mine p
  mine=$(ps -o pgid= -p $$ | tr -d ' ')
  for p in $(pgrep -f "$1" 2>/dev/null); do
    [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$mine" ] || echo "$p"
  done
}

preflight() {
  step "Checking that it is safe to start (read-only: nothing is changed)"
  [ "$(uname -s)" = Darwin ] || refuse "macOS only"
  [ "$(uname -m)" = arm64 ] || refuse "Apple silicon (arm64) only"
  local major
  major=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  [ "${major:-0}" -ge 27 ] 2>/dev/null || refuse "needs macOS 27 or later (found $(sw_vers -productVersion 2>/dev/null))"
  [ "$(id -u)" != 0 ] || refuse "run it as yourself, not with sudo: it asks for your password once, and Playwright must run as you"
  if [ "$DRY" != 1 ] && ! [ -t 0 ]; then refuse "run it in a terminal: sudo asks for your password there"; fi

  local t
  for t in node npx go curl shasum ifconfig route netstat arp ndp pfctl dnctl launchctl scutil pgrep pkill sysctl awk sed grep mktemp tee; do
    command -v "$t" >/dev/null 2>&1 || refuse "missing tool: $t"
  done
  if command -v node >/dev/null 2>&1; then
    local nv
    nv=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
    [ "${nv:-0}" -ge 22 ] 2>/dev/null || refuse "needs Node.js 22 or later (found $(node --version 2>/dev/null))"
  fi
  [ -d "$REPO/app/node_modules/koffi" ] || refuse "app/node_modules is missing (the netsim self-test loads koffi from it): run 'npm ci' in app/"
  if selected app; then
    [ -e "$REPO/app/node_modules/.bin/playwright" ] || refuse "Playwright is not installed in app/node_modules"
    if [ "$BUILD" = 0 ] && [ ! -f "$REPO/app/out/main/index.js" ]; then refuse "--no-build, but app/out is not built"; fi
  fi

  # Something else of ours, or something that would interfere, is running.
  [ -z "$(others_running "$TEST_BIN/")" ] || refuse "a Mergelane acceptance daemon is running ($TEST_BIN)"
  [ -z "$(others_running 'scripts/(netsim/with-netsim|acceptance/daemon|ci/local-root)\.sh')" ] ||
    refuse "another Mergelane root test run is active: $(others_running 'scripts/(netsim/with-netsim|acceptance/daemon|ci/local-root)\.sh' | tr '\n' ' ')"
  [ ! -e /var/run/mergelane-netsim ] || refuse "netsim is up (another run, or one that did not finish): run '$SELF --restore'"
  [ ! -e "$BACKUP" ] || refuse "an earlier run's helper backup is still at $BACKUP: run '$SELF --restore' first"
  local i
  for i in feth10 feth11 feth20 feth21; do
    if ifconfig "$i" >/dev/null 2>&1; then refuse "interface $i exists; netsim needs that name ('$SELF --restore' removes netsim's own)"; fi
  done
  [ -z "$(others_running 'Mergelane.app/Contents/MacOS/')" ] ||
    refuse "Mergelane.app is running: quit it first (it would talk to the test daemons or offer to reinstall its helper)"
  # The test runner and its workers; not the @playwright/mcp servers an editor may keep running.
  [ -z "$(others_running 'playwright test|playwright/lib/(common|runner)/process')" ] ||
    refuse "a Playwright test run is active (another terminal or agent): wait for it to finish"
  [ -z "$(others_running 'electron-vite')" ] || refuse "electron-vite is running in another terminal: wait for it to finish"
  curl -s -o /dev/null --max-time 2 http://127.0.0.1:8090/
  [ $? -eq 7 ] || refuse "something already listens on 127.0.0.1:8090 (the netsim test server's control port)"

  # A VPN, or netsim's address ranges already in use.
  netstat -rn >"$RUN_TMP/routes-check" 2>&1
  scutil --nc list >"$RUN_TMP/scutil" 2>&1
  ifconfig -a >"$RUN_TMP/ifconfig" 2>&1
  local line
  while IFS= read -r line; do [ -n "$line" ] && refuse "a VPN is active: $line"; done < <(node "$LIB" vpn "$RUN_TMP/routes-check" "$RUN_TMP/scutil")
  while IFS= read -r line; do [ -n "$line" ] && refuse "netsim's addresses collide: $line"; done < <(node "$LIB" overlaps "$RUN_TMP/ifconfig" "$RUN_TMP/routes-check")

  # pf must evaluate com.apple/* anchors (the default /etc/pf.conf does), and the receive check
  # must accept packets redirected to lo0 (xnu ip_input.c: only check_interface=2 drops them).
  local a
  for a in 'rdr-anchor "com.apple/\*"' 'dummynet-anchor "com.apple/\*"'; do
    grep -qE "^$a" /etc/pf.conf 2>/dev/null || refuse "/etc/pf.conf lacks $a (netsim's anchor would never be evaluated)"
  done
  local v
  for v in net.inet.ip.check_interface net.inet6.ip6.check_interface; do
    [ "$(sysctl -n "$v" 2>/dev/null)" != 2 ] || refuse "$v is 2 (strong end-system model): packets netsim redirects to lo0 would be dropped"
  done
  local fw=/usr/libexec/ApplicationFirewall/socketfilterfw
  if [ -x "$fw" ]; then
    note "macOS firewall: $("$fw" --getglobalstate 2>/dev/null | head -1)"
    if "$fw" --getappblocked "$(command -v node)" 2>/dev/null | grep -qi 'blocked'; then
      refuse "the macOS firewall blocks incoming connections to $(command -v node); the netsim test server needs them"
    fi
  fi

  # Mergelane's installed helper, and which of the go suite's lo0 aliases exist already.
  helper_facts >"$RUN_TMP/manifest"
  echo "lo0_before=$(ifconfig lo0 2>/dev/null | awk '$1 == "inet" && ($2 == "127.0.0.2" || $2 == "127.0.0.3") {printf "%s ", $2}')" >>"$RUN_TMP/manifest"
  note "Mergelane helper: $(tr '\n' ' ' <"$RUN_TMP/manifest" | sed -E 's/(plist|binary)_sha=([0-9a-f]{12})[0-9a-f]*/\1_sha=\2…/g')"
  case $(fact merge "$RUN_TMP/manifest") in
    unreachable) refuse "the installed helper is loaded but does not answer on its socket, so it cannot be paused safely" ;;
  esac
  if [ "$(fact loaded "$RUN_TMP/manifest")" = yes ] && [ "$(fact binary "$RUN_TMP/manifest")" = absent ]; then
    refuse "launchd has the helper loaded but its binary is missing; fix that first"
  fi

  if [ -n "$REFUSALS" ]; then
    say ""
    say "local-root: NOT STARTING. Nothing was changed. Reasons:"
    printf '%s' "$REFUSALS" | sed 's/^/  - /'
    return 1
  fi
  note "all checks passed"
}

print_plan() {
  local helper merge
  helper=$(fact loaded "$RUN_TMP/manifest")
  merge=$(fact merge "$RUN_TMP/manifest")
  step "What happens next"
  say "Suites: ${ONLY//,/, }. About 20 minutes in all (go ~1, netsim ~3, daemon ~10, app ~5, plus building)."
  if [ "$helper" = yes ]; then
    say "- Mergelane's helper is paused for the whole run (merging is ${merge} now; off while paused)."
    say "  At the end it is restored exactly and, if merging was on, turned back on."
  else
    say "- Mergelane's helper is not loaded, so there is nothing to pause; its files are still backed up."
  fi
  if selected daemon; then
    say "- YOUR INTERNET STOPS WORKING at times during the daemon suite: whenever a test daemon merges"
    say "  over the two simulated links only. Stretches of a few seconds up to about a minute, about"
    say "  3 minutes in all, within roughly 10 minutes. Calls and downloads in progress may drop."
  fi
  say "- Test links feth10/feth20 appear, pf gets the anchor $ANCHOR (enabled with its own reference),"
  say "  and dummynet pipes 7711-7722 are created. All of it is removed and checked at the end."
  say "- macOS may ask whether 'node' may accept incoming connections: click Allow."
  print_recovery
}

print_recovery() {
  step "If this Mac is left in a bad state (script killed, power lost...)"
  say "Run:   bash \"$SELF\" --restore"
  say "or these, one at a time (each is safe to repeat):"
  say "  sudo pkill -f $TEST_BIN/                           # test daemons and the fake VPN"
  say "  sudo $TEST_BIN/mergelane-daemon cleanup            # their routes, if that file exists"
  say "  sudo bash \"$NETSIM\" down --sweep    # feth links, pf anchor, pipes, lo0 addresses"
  say "  sudo pfctl -a $ANCHOR -F rules; sudo pfctl -a $ANCHOR -F nat   # this anchor only"
  say "  sudo ifconfig feth10 destroy; sudo ifconfig feth11 destroy; sudo ifconfig feth20 destroy; sudo ifconfig feth21 destroy"
  say "  sudo dnctl pipe delete 7711; sudo dnctl pipe delete 7712; sudo dnctl pipe delete 7721; sudo dnctl pipe delete 7722"
  say "  sudo route -n delete -host 192.0.2.77                # only if the leak test was cut short"
  say "and to put the helper back from $BACKUP:"
  say "  sudo launchctl bootout system/$LABEL                 # if a test copy is loaded"
  if [ "$(fact plist "$RUN_TMP/manifest")" = present ]; then
    say "  sudo cp -p $BACKUP/plist $PLIST"
    say "  sudo cp -p $BACKUP/binary $HELPER"
    [ "$(fact state "$RUN_TMP/manifest")" = present ] && say "  sudo rm -rf \"$HELPER_STATE\" && sudo cp -Rp $BACKUP/state \"$HELPER_STATE\""
    [ "$(fact loaded "$RUN_TMP/manifest")" = yes ] && say "  sudo launchctl bootstrap system $PLIST"
    [ "$(fact merge "$RUN_TMP/manifest")" = on ] && say "  $HELPER on                    # merging was on"
    say "  sudo rm -rf $BACKUP                                  # once the helper works again"
  else
    say "  (it was not installed: sudo rm -f $PLIST $HELPER, then sudo rm -rf $BACKUP)"
  fi
  say "A reboot also clears every network change above (none of them persist); only the helper's"
  say "files need the commands, and --restore does all of it."
}

# ---------------------------------------------------------------------------------------------
# 2. sudo

KEEPALIVE=""
SUDO_STARTED=0
start_sudo() {
  step "Asking for your password once (sudo). It is never stored."
  if [ "$DRY" = 1 ]; then
    say "  sudo -v   (then 'sudo -n -v' every 30 s while the run lasts)"
    return 0
  fi
  sudo -v || return 1
  SUDO_STARTED=1
  local main=$$
  (
    trap '' INT HUP
    while kill -0 "$main" 2>/dev/null; do
      sudo -n -v 2>/dev/null
      sleep 30
    done
  ) &
  KEEPALIVE=$!
  # The suites call sudo from child processes (bash, node). sudoers' default timestamp_type is tty
  # (sudoers(5)), so they share this terminal's timestamp; check it rather than assume it.
  if ! bash -c 'sudo -n true' 2>/dev/null ||
    ! node -e 'require("child_process").execFileSync("sudo", ["-n", "true"], { stdio: "ignore" })' 2>/dev/null; then
    say "local-root: child processes cannot reuse sudo's timestamp (sudoers timestamp_type or timestamp_timeout?)."
    say "Nothing was changed."
    return 1
  fi
}

root_preflight() {
  step "Checking what only root can read (nothing is changed)"
  local pipes anchor
  pipes=$(priv dnctl pipe show 2>/dev/null)
  if node -e 'process.exit(process.argv[1].split("\n").some(l => /^0*77[1-8][12]:/.test(l)) ? 1 : 0)' "$pipes"; then :; else
    refuse "dummynet pipes in netsim's range 7711-7782 already exist: $(grep -E '^0*77[1-8][12]:' <<<"$pipes" | cut -d: -f1 | tr '\n' ' ')"
  fi
  anchor=$({ priv pfctl -q -a "$ANCHOR" -s rules; priv pfctl -q -a "$ANCHOR" -s nat; priv pfctl -q -a "$ANCHOR" -s dummynet; } 2>/dev/null)
  [ "$DRY" = 1 ] || [ -z "$anchor" ] || refuse "pf anchor $ANCHOR already has rules: $anchor"
  priv pfctl -s References >"$RUN_TMP/pf-references-before" 2>&1
  if [ -n "$REFUSALS" ]; then
    say "local-root: NOT STARTING. Nothing was changed. Reasons:"
    printf '%s' "$REFUSALS" | sed 's/^/  - /'
    return 1
  fi
  note "ok"
}

# ---------------------------------------------------------------------------------------------
# 3. Pause and back up the helper

ARMED=0    # a backup exists: on any exit, restore
RESTORED=0 # the restore has run
WATCHDOG=""
pause_helper() {
  step "Pausing Mergelane's helper (restored at the end)"
  local m="$RUN_TMP/manifest"
  {
    echo "created=$(date)"
    echo "runner_pid=$$"
    echo "repo=$REPO"
  } >>"$m"
  priv mkdir -m 700 "$BACKUP" || {
    say "local-root: could not create $BACKUP; nothing was changed"
    return 1
  }
  ARMED=1 # from here on, every way out restores (an incomplete backup means the helper is untouched)
  [ "$(fact plist "$m")" = present ] && { priv cp -p "$PLIST" "$BACKUP/plist" || return 1; }
  [ "$(fact binary "$m")" = present ] && { priv cp -p "$HELPER" "$BACKUP/binary" || return 1; }
  [ "$(fact state "$m")" = present ] && { priv cp -Rp "$HELPER_STATE" "$BACKUP/state" || return 1; }
  if [ "$DRY" != 1 ]; then
    [ "$(fact plist "$m")" = absent ] || [ "$(priv shasum -a 256 "$BACKUP/plist" | cut -d' ' -f1)" = "$(fact plist_sha "$m")" ] || return 1
    [ "$(fact binary "$m")" = absent ] || [ "$(priv shasum -a 256 "$BACKUP/binary" | cut -d' ' -f1)" = "$(fact binary_sha "$m")" ] || return 1
  fi
  # The manifest goes in last: without it, the helper was never touched.
  priv cp "$m" "$BACKUP/manifest" || return 1
  local saved="" what
  for what in plist binary state; do [ "$(fact "$what" "$m")" = present ] && saved="$saved $what"; done
  note "backed up to $BACKUP (root only):${saved:- nothing to copy, the helper is not installed}"
  start_watchdog

  if [ "$(fact merge "$m")" = on ]; then
    if [ "$DRY" = 1 ]; then say "  [you]  $HELPER off"; else note "$("$HELPER" off 2>&1 | head -1)"; fi
  fi
  if [ "$(fact loaded "$m")" = yes ]; then
    priv launchctl bootout "system/$LABEL"
    if [ "$DRY" != 1 ]; then
      local _
      for _ in $(seq 1 150); do loaded || break; sleep 0.1; done
      if loaded || pgrep -f "^$HELPER run" >/dev/null; then
        say "local-root: the helper did not stop"
        return 1
      fi
      note "helper booted out of launchd"
    fi
  fi
  [ "$(fact binary "$m")" = present ] && priv_quiet "$HELPER" cleanup
  if [ "$DRY" != 1 ]; then
    netstat -rn >"$RUN_TMP/routes-paused"
    if ! node "$LIB" marked "$RUN_TMP/routes-paused" >/dev/null; then
      say "local-root: Mergelane routes remain after pausing the helper:"
      node "$LIB" marked "$RUN_TMP/routes-paused" | indent
      return 1
    fi
    note "merging off, no Mergelane routes left"
  fi
}

start_watchdog() {
  if [ "$DRY" = 1 ]; then
    say "  [root] (in the background) bash $SELF --watchdog <this script's pid> <log>"
    return 0
  fi
  WATCHDOG=$(sudo -n bash -c 'nohup bash "$0" --watchdog "$1" "$2" "$3" </dev/null >/dev/null 2>&1 & echo $!' \
    "$SELF" "$$" "$LOG" "$(ps -o pgid= -p $$ | tr -d ' ')" | tr -d '\r')
  note "root watchdog (pid $WATCHDOG) restores the Mac if this script dies"
}

# Runs as root, detached. When the runner is gone without having restored, restores.
watchdog_main() {
  trap '' INT TERM HUP
  [ "$(id -u)" = 0 ] || exit 2
  PATH="$PATH:/usr/local/bin:/opt/homebrew/bin" # node, wherever sudo's PATH left it
  local started
  started=$(ps -o lstart= -p "$WATCH_PID" 2>/dev/null)
  [ -n "$started" ] || exit 0
  while [ "$(ps -o lstart= -p "$WATCH_PID" 2>/dev/null)" = "$started" ]; do sleep 2; done
  [ -d "$BACKUP" ] && [ ! -e "$BACKUP/finished" ] || exit 0
  # Killed alone, the runner leaves its suites running (daemon.sh, the test server, Playwright):
  # stop its process group first, sparing this watchdog, which may be in it. Only when the runner
  # led its group, as a command typed in Terminal does, so nothing outside the run is touched.
  if [ -n "$WATCH_PGID" ] && [ "$WATCH_PGID" = "$WATCH_PID" ]; then
    local sig p
    for sig in TERM KILL; do
      for p in $(pgrep -g "$WATCH_PGID" 2>/dev/null); do [ "$p" = "$$" ] || kill "-$sig" "$p" 2>/dev/null; done
      [ "$sig" = TERM ] && sleep 5
    done
  fi
  RUN_TMP=$(mktemp -d -t mergelane-local-root-watchdog)
  RESULTS="$RUN_TMP/results"
  : >"$RESULTS"
  {
    step "watchdog: the runner (pid $WATCH_PID) ended before restoring this Mac; restoring now as root"
    restore_everything
    node "$LIB" summary "$RESULTS"
  } >>"$WATCH_LOG" 2>&1
  rm -rf "$RUN_TMP"
}

# ---------------------------------------------------------------------------------------------
# 4. Suites

NOISE=""
ABORT=0
run_suite() { # <name> <command...>
  local name=$1 t0=$SECONDS rc
  shift
  if [ "$ABORT" = 1 ]; then
    record "$name" SKIP 0 "not run: the previous suite left state behind"
    return
  fi
  step "Suite: $name"
  "$@"
  rc=$?
  if [ "$rc" -eq 0 ]; then record "$name" PASS $((SECONDS - t0)); else record "$name" FAIL $((SECONDS - t0)) "exit $rc"; fi
  gate "$name"
}

# CI's daemon job adds these two lo0 aliases with sudo for upstream's SOCKS and probe tests, which
# skip themselves without them (daemon/internal/engine/socks5_test.go). Only missing ones are added,
# and only those are removed.
suite_go() {
  local ip added="" rc
  for ip in 127.0.0.2 127.0.0.3; do
    case " $(fact lo0_before "$RUN_TMP/manifest") " in *" $ip "*) continue ;; esac
    priv ifconfig lo0 alias "$ip/32" && added="$added $ip"
  done
  (cd "$REPO/daemon" && go test -race -count=1 -v ./internal/engine/) >"$RUN_TMP/go-engine.log" 2>&1
  rc=$?
  for ip in $added; do priv ifconfig lo0 -alias "$ip"; done
  grep -E '^(--- (FAIL|SKIP)|FAIL|ok|PASS)|not bindable' "$RUN_TMP/go-engine.log"
  if grep -q 'not bindable' "$RUN_TMP/go-engine.log"; then
    say "the SOCKS tests still skipped: the lo0 aliases did not take"
    return 1
  fi
  return "$rc"
}
suite_netsim_unit() {
  node --test "$REPO"/scripts/netsim/*.test.mjs && bash "$REPO/scripts/netsim/netsim.test.sh"
}
suite_netsim_selftest() {
  NETSIM_SNAPSHOT_IGNORE=$NOISE bash "$WITH_NETSIM" "$SPECS" -- bash "$REPO/scripts/netsim/selftest.sh"
}
suite_netsim_leak() { # the CI step "A leftover route fails the run"
  local rc=0
  if NETSIM_SNAPSHOT_IGNORE=$NOISE bash "$WITH_NETSIM" "1:20:10:0" -- sudo route -q -n add -host 192.0.2.77 127.0.0.1; then
    say "with-netsim did not notice the leftover route"
    rc=1
  else
    say "(the FAIL above is expected: with-netsim noticed the route this step left behind)"
  fi
  # As in CI: the route must be there to delete, or with-netsim failed for another reason.
  if ! sudo -n route -q -n delete -host 192.0.2.77 127.0.0.1 >/dev/null; then
    say "the leftover route was never added, so this step proved nothing (see the output above)"
    rc=1
  fi
  return "$rc"
}
suite_daemon() {
  NETSIM_SNAPSHOT_IGNORE=$NOISE MERGELANE_HELPER_BACKED_UP=$BACKUP RUNNER_TEMP=$RUN_TMP \
    bash "$WITH_NETSIM" "$SPECS" -- bash "$REPO/scripts/acceptance/daemon.sh"
}
suite_app() {
  # Workers 1: both tests share the links, and one of them drops link 2 mid-download.
  NETSIM_SNAPSHOT_IGNORE=$NOISE bash "$WITH_NETSIM" "$SPECS" -- bash -c \
    'cd "$1" && MERGELANE_E2E_SKIP_BUILD=1 npx playwright test --grep @netsim --reporter=list --workers=1 --output "$2"' \
    _ "$REPO/app" "$RUN_TMP/playwright"
}

collect_state() { # <dir>: what the leftover check reads
  mkdir -p "$1"
  ifconfig -l >"$1/ifaces" 2>&1
  ifconfig lo0 >"$1/lo0" 2>&1
  netstat -rn >"$1/routes" 2>&1
  priv dnctl pipe show >"$1/pipes" 2>/dev/null
  { priv pfctl -q -a "$ANCHOR" -s rules; priv pfctl -q -a "$ANCHOR" -s nat; priv pfctl -q -a "$ANCHOR" -s dummynet; } >"$1/anchor" 2>/dev/null
  { arp -an; ndp -an; } >"$1/neighbors" 2>/dev/null
  { pgrep -fl "$TEST_BIN/" || true; } >"$1/processes"
  { [ -e /var/run/mergelane-netsim ] && echo "/var/run/mergelane-netsim exists"; } >>"$1/processes"
  # lo0 aliases there before the run: from this run's record, or the backup's (watchdog, --restore).
  { fact lo0_before "$RUN_TMP/manifest" 2>/dev/null; priv cat "$BACKUP/manifest" 2>/dev/null | sed -n 's/^lo0_before=//p'; } >"$1/lo0-before"
}
leftovers() { # prints what is left; returns 1 if anything
  local d="$RUN_TMP/state.$RANDOM"
  collect_state "$d"
  local out
  out=$(node "$LIB" leftovers "$d"; sed 's/^/process or state: /' "$d/processes")
  rm -rf "$d"
  [ -z "$out" ] && return 0
  say "$out"
  return 1
}
cleanup_harness() { # removes whatever the suites may have left; idempotent
  priv_quiet pkill -f "^$TEST_BIN/"
  priv_quiet pkill -f "$REPO/scripts/netsim/server.mjs" # with-netsim's test server, if it outlived it
  # The go suite's lo0 aliases, unless they were there before the run (from the backup's record).
  local before="" ip
  if [ "$DRY" = 1 ]; then before=$(fact lo0_before "$RUN_TMP/manifest"); else before=$(priv cat "$BACKUP/manifest" 2>/dev/null | sed -n 's/^lo0_before=//p'); fi
  if [ "$DRY" = 1 ] || priv test -f "$BACKUP/manifest"; then
    for ip in 127.0.0.2 127.0.0.3; do
      case " $before " in *" $ip "*) continue ;; esac
      if [ "$DRY" = 1 ] || ifconfig lo0 | grep -q "inet $ip "; then priv_quiet ifconfig lo0 -alias "$ip"; fi
    done
  fi
  [ "$DRY" = 1 ] || sleep 1
  if [ -x "$TEST_BIN/mergelane-daemon" ] || [ "$DRY" = 1 ]; then priv_quiet "$TEST_BIN/mergelane-daemon" cleanup; fi
  priv rm -rf /var/run/mergelane-acceptance
  if [ "$DRY" = 1 ]; then
    say "  [root] bash $NETSIM down --sweep, which here would run:"
    NETSIM_DRY_RUN=1 bash "$NETSIM" down --sweep 2>&1 | indent
  else
    priv bash "$NETSIM" down --sweep 2>&1 | indent
  fi
  if [ "$DRY" = 1 ] || [ "$(route -n get 192.0.2.77 2>/dev/null | awk '/gateway:/{print $2}')" = 127.0.0.1 ]; then
    priv_quiet route -q -n delete -host 192.0.2.77 127.0.0.1
  fi
}
gate() { # after each suite: nothing of the harness may be left before the next one starts
  local left
  if left=$(leftovers); then return 0; fi
  say "local-root: after '$1' these were left behind (the suite's own cleanup should have removed them):"
  say "$left" | indent
  record "$1: left nothing behind" FAIL 0 "$(echo "$left" | head -1)"
  cleanup_harness
  if left=$(leftovers); then
    note "removed them; continuing"
  else
    say "local-root: could not remove them; the remaining suites are skipped"
    say "$left" | indent
    ABORT=1
  fi
}

# ---------------------------------------------------------------------------------------------
# 5. Restore and verify

restore_helper() {
  step "Restoring Mergelane's helper"
  local m="$RUN_TMP/manifest-backup" t0=$SECONDS
  if [ "$DRY" = 1 ]; then
    cp "$RUN_TMP/manifest" "$m"
  elif ! priv test -d "$BACKUP"; then
    note "no backup at $BACKUP: the helper was never paused"
    return 0
  elif ! priv cat "$BACKUP/manifest" >"$m" 2>/dev/null; then
    # The manifest is written last, so the helper was never touched: only the partial backup goes.
    note "the backup is incomplete, so the helper was never paused; removing $BACKUP"
    priv rm -rf "$BACKUP"
    return 0
  fi
  local now="$RUN_TMP/manifest-now"
  helper_facts >"$now"
  # 1. A test copy may be loaded under the real label: stop it.
  if [ "$(fact loaded "$now")" = yes ] && { [ "$(fact plist_sha "$now")" != "$(fact plist_sha "$m")" ] ||
    [ "$(fact binary_sha "$now")" != "$(fact binary_sha "$m")" ]; } || [ "$DRY" = 1 ]; then
    [ "$DRY" = 1 ] && say "  (only if a test copy is loaded under the helper's label, as the ADR-0017 section does)"
    priv_quiet launchctl bootout "system/$LABEL"
    local _
    for _ in $(seq 1 150); do [ "$DRY" = 1 ] || ! loaded && break; sleep 0.1; done
  fi
  # 2. The files, exactly: cp -p keeps mode, owner, flags, times, ACLs and extended attributes
  # (cp(1)); copied beside the target and renamed into place.
  local what src dst
  for what in plist binary; do
    if [ "$what" = plist ]; then dst=$PLIST; else dst=$HELPER; fi
    src="$BACKUP/$what"
    if [ "$(fact "$what" "$m")" = present ]; then
      if [ "$(sha_of "$dst")" != "$(fact "${what}_sha" "$m")" ] || [ "$DRY" = 1 ]; then
        priv cp -p "$src" "$dst.local-ci-restore" && priv mv -f "$dst.local-ci-restore" "$dst"
      fi
    elif [ -e "$dst" ] || [ "$DRY" = 1 ]; then
      priv rm -f "$dst"
    fi
  done
  if [ "$(fact state "$m")" = present ]; then
    priv rm -rf "$HELPER_STATE"
    priv cp -Rp "$BACKUP/state" "$HELPER_STATE"
  else
    priv rm -rf "$HELPER_STATE"
    [ "$(fact support "$m")" = present ] || priv_quiet rmdir "$SUPPORT" # only if the tests left it empty
  fi
  # 3. launchd's persistent enable/disable record, then the job itself.
  if [ "$(fact disabled "$m")" = disabled ]; then priv launchctl disable "system/$LABEL"; fi
  if [ "$(fact loaded "$m")" = yes ]; then
    loaded && [ "$DRY" != 1 ] || priv launchctl bootstrap system "$PLIST"
    if [ "$DRY" != 1 ]; then
      for _ in $(seq 1 200); do "$HELPER" status >/dev/null 2>&1 && break; sleep 0.1; done
    fi
  fi
  # 4. Merging back on, once a link has passed its probe.
  if [ "$(fact merge "$m")" = on ]; then
    if [ "$DRY" = 1 ]; then
      say "  [you]  $HELPER on   (once '$HELPER links' shows a link up)"
    else
      for _ in $(seq 1 200); do "$HELPER" links 2>/dev/null | grep -q ' up  ' && break; sleep 0.1; done
      for _ in 1 2 3 4 5; do
        "$HELPER" on >/dev/null 2>&1 && "$HELPER" status 2>/dev/null | grep -q '^system merge: on' && break
        sleep 3
      done
      note "$("$HELPER" status 2>&1 | head -1)"
    fi
  fi
  [ "$DRY" = 1 ] && return 0
  # 5. Verify against the record. The settings folder was put back before the helper started, but
  # is not compared: a current helper rewrites prefs.json at every start (ADR-0024).
  helper_facts >"$now"
  local diffs
  if diffs=$(node "$LIB" helper-diff "$m" "$now"); then
    record "helper restored as it was" PASS $((SECONDS - t0)) "$(fact loaded "$m" | sed 's/yes/loaded/;s/no/not loaded/'), merging $(fact merge "$now")"
    priv rm -rf "$BACKUP"
    note "restored and verified; backup removed"
  else
    record "helper restored as it was" FAIL $((SECONDS - t0)) "$(echo "$diffs" | tr '\n' ';')"
    say "local-root: the helper differs from before; the backup stays at $BACKUP:"
    say "$diffs" | indent
    priv touch "$BACKUP/finished"
  fi
}

restore_everything() {
  RESTORED=1 # whatever happens next, do not start over from the exit trap
  step "Removing everything the tests may have left"
  cleanup_harness
  local left
  if [ "$DRY" = 1 ]; then :; elif left=$(leftovers); then
    record "nothing left behind (feth, pf anchor, pipes, lo0, routes)" PASS 0
  else
    record "nothing left behind (feth, pf anchor, pipes, lo0, routes)" FAIL 0 "$(echo "$left" | tr '\n' ';')"
    say "$left" | indent
  fi
  restore_helper
}

final_checks() {
  step "Checking that the tests left nothing behind"
  netstat -rn >"$RUN_TMP/routes-after-suites"
  local d
  if d=$(node "$LIB" compare "$RUN_TMP/routes-paused" "$RUN_TMP/routes-after-suites" --ignore-noise); then
    record "routing table as before the suites" PASS 0
  else
    record "routing table as before the suites" FAIL 0 "$(echo "$d" | wc -l | tr -d ' ') lines differ"
    say "$d" | indent
  fi
  restore_everything
  step "Final checks"
  netstat -rn >"$RUN_TMP/routes-end"
  if d=$(node "$LIB" compare "$RUN_TMP/routes-start" "$RUN_TMP/routes-end" --ignore-noise); then
    record "routing table as at the start (helper's utun renamed)" PASS 0
  else
    record "routing table as at the start (helper's utun renamed)" FAIL 0 "$(echo "$d" | wc -l | tr -d ' ') lines differ"
    say "$d" | indent
  fi
  if [ "$(fact merge "$RUN_TMP/manifest")" = on ]; then
    [ -n "$(node "$LIB" helper-iface "$RUN_TMP/routes-end")" ] && note "merging is on again ($(node "$LIB" helper-iface "$RUN_TMP/routes-end"))"
  fi
  local ok=""
  for _ in 1 2 3 4 5 6; do
    curl -fsS -o /dev/null --max-time 10 https://api.github.com/ 2>/dev/null && ok=yes && break
    sleep 5
  done
  if [ -n "$ok" ]; then record "the internet works" PASS 0 "https://api.github.com/"; else record "the internet works" FAIL 0 "https://api.github.com/ unreachable for 60 s"; fi
  priv pfctl -s References >"$RUN_TMP/pf-references-after" 2>&1
  local extra
  extra=$(comm -13 <(awk 'NF >= 3 && $3 ~ /^[0-9]+$/ {print $3}' "$RUN_TMP/pf-references-before" | sort) \
    <(awk 'NF >= 3 && $3 ~ /^[0-9]+$/ {print $3}' "$RUN_TMP/pf-references-after" | sort))
  [ -z "$extra" ] || note "pf enable references that were not there at the start (another program's, or netsim's if it was cut short): $extra"
}

# ---------------------------------------------------------------------------------------------

finish_logs() {
  if [ "$DRY" = 1 ]; then
    rm -rf "$RUN_TMP"
    return
  fi
  if [ -d "$RUN_TMP" ]; then
    [ "$SUDO_STARTED" = 1 ] && priv chown -R "$(id -u):$(id -g)" "$RUN_TMP" 2>/dev/null
    [ -f "$RUN_TMP/mergelane-acceptance/daemon.log" ] && cp "$RUN_TMP/mergelane-acceptance/daemon.log" "$LOG_DIR/root-$STAMP-daemon.log"
    if [ -d "$RUN_TMP/playwright" ] && [ -n "$(ls -A "$RUN_TMP/playwright" 2>/dev/null)" ]; then
      cp -R "$RUN_TMP/playwright" "$LOG_DIR/root-$STAMP-playwright"
    fi
    rm -rf "$RUN_TMP"
  fi
  # Only after this run used it: a refused run may have found another run's copy there.
  [ "$ARMED" = 1 ] && [ -O "$TEST_BIN" ] && rm -rf "$TEST_BIN"
  return 0
}

on_exit() {
  local rc=$?
  trap '' INT TERM HUP
  if [ "$ARMED" = 1 ] && [ "$RESTORED" != 1 ]; then
    say ""
    say "local-root: stopping early (exit $rc); restoring this Mac now. Ctrl-C is ignored until it is done."
    restore_everything
  fi
  if [ -n "$RESULTS" ] && [ -s "$RESULTS" ]; then
    step "Summary"
    node "$LIB" summary "$RESULTS"
    node "$LIB" summary "$RESULTS" >/dev/null || rc=1
  fi
  [ -n "$KEEPALIVE" ] && kill "$KEEPALIVE" 2>/dev/null
  if [ -n "${STAMP:-}" ]; then
    finish_logs
    say "Log: $LOG"
  fi
  [ "$SUDO_STARTED" = 1 ] && sudo -k # forget the cached password now
  exit "$rc"
}

dry_run_plan() {
  step "Dry run: every command that needs root, in order. Nothing is run."
  local st
  st=$(mktemp -d)
  start_sudo
  root_preflight >/dev/null
  say "  [root] dnctl pipe show; pfctl -a $ANCHOR -s rules|nat|dummynet; pfctl -s References"
  pause_helper
  if selected go; then
    step "Suite go: lo0 aliases for the engine tests, as root (only those missing now; removed after):"
    local ip
    for ip in 127.0.0.2 127.0.0.3; do
      case " $(fact lo0_before "$RUN_TMP/manifest") " in *" $ip "*) note "$ip is already on lo0: left alone" ;; *)
        priv ifconfig lo0 alias "$ip/32"
        priv ifconfig lo0 -alias "$ip"
        ;;
      esac
    done
  fi
  if selected netsim; then
    step "Suite netsim: with-netsim.sh brings the links up, as root:"
    NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/n" bash "$NETSIM" up "${SPEC_LIST[@]}" 2>&1 | indent
    say "  the self-test then drops and restores link 2 (loss, down, gone), as root:"
    local mode
    for mode in loss down gone; do
      NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/n" bash "$NETSIM" drop 2 "$mode" 2>&1 | indent
      NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/n" bash "$NETSIM" restore 2 2>&1 | indent
    done
    say "  and with-netsim takes everything down again, as root:"
    NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/n" bash "$NETSIM" down 2>&1 | indent
    say "  leak check: sudo route -q -n add -host 192.0.2.77 127.0.0.1, then delete"
  fi
  if selected daemon; then
    step "Suite daemon: the same netsim up and down, plus these sudo calls in scripts/acceptance/daemon.sh:"
    grep -nE '(^|[^a-z_])sudo ' "$REPO/scripts/acceptance/daemon.sh" | grep -vE '^[0-9]+:[[:space:]]*#' | indent
  fi
  if selected app; then
    step "Suite app: the same netsim up and down; the Playwright spec (as you) calls:"
    grep -nE "execFileSync\('sudo'" "$REPO/app/e2e/netsimDownload.spec.ts" | indent
    say "    sudo bash $NETSIM via 1 adds, as root:"
    NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/a" bash "$NETSIM" up "${SPEC_LIST[@]}" >/dev/null 2>&1
    NETSIM_DRY_RUN=1 NETSIM_STATE_DIR="$st/a" bash "$NETSIM" via 1 2>&1 | indent
  fi
  step "Between suites and at the end, as root (only what is found):"
  cleanup_harness
  restore_helper
  ARMED=0 # a dry run changed nothing
  rm -rf "$st"
}

main() {
  setup_log
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  [ "$DRY" = 1 ] && say "local-root: DRY RUN: read-only checks, then the plan. sudo is never called."
  local refused=0
  preflight || refused=1
  if [ "$DRY" = 1 ]; then
    print_plan
    dry_run_plan
    [ "$refused" = 0 ] || say $'\nlocal-root: DRY RUN done. A real run would NOT start now, for the reasons listed above.'
    exit $((refused * 2))
  fi
  [ "$refused" = 0 ] || exit 2
  print_plan
  if [ "$YES" != 1 ]; then
    printf '\nPress Enter to start, or Ctrl-C to cancel: '
    read -r _ </dev/tty || exit 130
  fi
  start_sudo || exit 2
  root_preflight || exit 2
  NOISE=$(node "$LIB" noise-regex)
  if selected app && [ "$BUILD" = 1 ]; then
    step "Building the app into app/out (as you; nothing is paused yet)"
    (cd "$REPO/app" && npx electron-vite build) || {
      say "local-root: the app did not build; nothing was changed"
      exit 2
    }
  fi
  netstat -rn >"$RUN_TMP/routes-start"
  pause_helper || {
    say "local-root: pausing the helper failed; restoring"
    exit 1
  }
  selected go && run_suite "go: engine tests with lo0 aliases (CI job daemon's root step)" suite_go
  if selected netsim; then
    run_suite "netsim: unit tests" suite_netsim_unit
    run_suite "netsim: self-test (20 + 50 Mbit/s links)" suite_netsim_selftest
    run_suite "netsim: a leftover route fails the run" suite_netsim_leak
  fi
  selected daemon && run_suite "daemon acceptance (Phase 1 3-6, ADR-0005/17/24/25, IPv6)" suite_daemon
  selected app && run_suite "app acceptance (Phase 1 criteria 2 and 6)" suite_app
  final_checks
}

case $MODE in
  watchdog) watchdog_main ;;
  restore)
    setup_log
    trap on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
    helper_facts >"$RUN_TMP/manifest" # what the helper looks like now, for the printed commands
    ARMED=1
    if [ "$DRY" = 1 ]; then
      say "local-root: DRY RUN of --restore: every command that may need root, in order. Nothing is run."
    else
      step "Restore: undoing whatever a Mergelane root test run left on this Mac"
      sudo -v || exit 2
      SUDO_STARTED=1
    fi
    restore_everything
    ;;
  *) main ;;
esac
