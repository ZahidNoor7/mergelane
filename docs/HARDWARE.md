# Real-hardware suite (M3.8)

The checks only real networks can prove: System merge across Wi-Fi, iPhone USB, Ethernet and Android USB at once,
one website kept on one network, a network unplugged and back, sleep and wake, a VPN turning on and off, and a
helper crash. You run it yourself, in your own Terminal, on your own Mac (docs/DECISIONS.md ADR-0050).

## Before you start

- Install Mergelane and update its helper, so both have the same version (Networks › System merge says so).
- Connect every network you want tested. At least two must reach the internet.
- Turn any VPN off.
- Pause big downloads, backups and video calls: they share the networks being measured.
- About 200 MB, plus about 50 MB per network you unplug, is downloaded from public speed-test files
  (Cloudflare, OVH, Hetzner). A phone's share counts against its data plan. The script says the total before it
  starts and asks first.

## Run it

```sh
node scripts/hardware/hardware.mjs
```

Options: `--links en0,en7` tests unplugging only those networks; `--skip unplug,sleep,vpn,crash,app` leaves those
checks out.

It never runs `sudo` by itself. The crash check is optional, shows the exact command (`sudo kill -9 <pid>`) and
asks for your password.

## What it checks

| Check | How it is decided |
| --- | --- |
| The helper answers, matches the app, two or more networks are up, no VPN, the internet works | Read from the helper, `netstat -rn`, `scutil --nc list` and a 1 MB download. Any failure stops the run before anything changes. |
| System merge turns on | The helper says `on` within 15 s, and exactly one of each of its two capture routes is in the routing table. |
| One site, sticky off: its connections spread | 8 downloads from one site; at least two networks carry 10% or more of the bytes. |
| One site, sticky on: it stays on one network | The same 8 downloads; only one network carries 15% or more. |
| Two hosts of one site stay on one network | Hetzner's two hosts (one site, hetzner.com); only one network carries 15% or more. |
| Different sites still spread | Cloudflare, OVH and Hetzner at once; at least two networks carry 10% or more. |
| Mergelane's own download uses every network | You start a download in Mergelane and say whether its networks all show traffic (the downloader pins each connection with `IP_BOUND_IF`). |
| Unplug a network: the others carry on | Downloads run while you unplug it. The helper sees it go within 30 s, merging stays on, a new download works, and at least one running download finishes. |
| Reconnect it: it is used again | It is back up within 2 minutes and carries 5% or more of new downloads. |
| Sleep and wake | Afterwards the helper answers, two networks are up, merging is on, its routes are there once, and the internet works. |
| A VPN turns merging off | Merging goes off with a reason naming the VPN, enabling is refused with `VPN_ACTIVE`, and none of Mergelane's routes remain. With the VPN off, merging turns on again. |
| A helper crash leaves the internet working | After `kill -9`, launchd starts a new helper, the routes match its state (none if off), and the internet works. |
| Put back as it was | Merging off (unless it was on before), sticky sites and every network's limit as they were, no routes left, the internet works. |

The shares come from the helper's `stats`, sampled every half second. To make downloads last long enough to
measure, and to keep the data predictable, every network is capped at 16 Mbit/s with the helper's own
per-network limit while the suite runs (4 Mbit/s while you unplug one). Your limits are put back at the end.

## When something goes wrong

- **Ctrl-C** at any point stops the run and puts everything back first.
- **Internet not working afterwards:** `sudo /Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon cleanup`
  removes any route Mergelane left behind.
- **Run cut off** (the Mac restarted mid-run): the script printed, before starting, the commands that put each
  network's limit back, for example
  `/Library/PrivilegedHelperTools/io.github.zahidnoor7.mergelane.daemon limit en0 0` (0 means no limit).

## The report

`local-ci-logs/hardware-<time>/report.md` (a table of every check) and `results.json`. The folder is ignored by
git. It holds network names (en0, en7), their kinds and versions, and no addresses.

## Its own tests

`node --test --experimental-test-coverage --test-coverage-include='scripts/hardware/hardware.mjs'
scripts/hardware/hardware.test.mjs` runs the whole suite against a stand-in Mac: every check passing and
failing, Ctrl-C, an unexpected error, a cleanup that finds routes left behind, plus the socket client, curl and
the prompts.
