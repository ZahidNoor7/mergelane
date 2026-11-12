package main

func init() {
	usage = `mergelane-daemon: merges every internet connection this PC has, system-wide.

  mergelane-daemon run --allowed-sid <SID>   serve the control pipe, merging off until asked (administrator; the service runs this)
  mergelane-daemon install --user-sid <SID> [--source <program>]   install as a Windows service (administrator)
  mergelane-daemon uninstall                 remove the service, its routes and its program (administrator)
  mergelane-daemon cleanup                   remove routes left behind after a crash (administrator)
  mergelane-daemon status | on | off | links | stats | events
  mergelane-daemon limit <link> <Mbit/s>     cap a link (0 removes the cap)
  mergelane-daemon auto-resume on|off        turn merging back on by itself after a crash (off by default)
  mergelane-daemon sticky-sites on|off       keep each website on one network (on by default)
  mergelane-daemon list                      show detected links
  mergelane-daemon version
`
}
