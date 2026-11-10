#!/usr/bin/env bash
# Spike S1: does a system LaunchDaemon with KeepAlive come back after kill -9, and how fast? Run as root.
set -u
LABEL=io.github.zahidnoor7.mergelane.spike
PLIST=/Library/LaunchDaemons/$LABEL.plist
LOG=/private/var/log/mergelane-spike.log
rm -f "$LOG"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>echo "start \$\$ \$(date +%s)" &gt;&gt; $LOG; exec /bin/sleep 1000</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>1</integer>
</dict></plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST"
launchctl bootstrap system "$PLIST"; echo "bootstrap exit $?"
sleep 2
pid_of() { launchctl print "system/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}'; }
P1=$(pid_of)
echo "pid before: $P1"
T0=$(date +%s)
kill -9 "$P1"
for i in $(seq 1 30); do
  sleep 1
  P2=$(pid_of)
  if [ -n "$P2" ] && [ "$P2" != "$P1" ]; then
    echo "RESTARTED pid=$P2 after $(( $(date +%s) - T0 )) s"
    break
  fi
done
[ -z "${P2:-}" ] || [ "$P2" = "$P1" ] && echo "NOT RESTARTED within 30 s"
cat "$LOG"
launchctl print "system/$LABEL" | grep -E 'state|runs|last exit' || true
launchctl bootout "system/$LABEL"; echo "bootout exit $?"
rm -f "$PLIST" "$LOG"
exit 0
