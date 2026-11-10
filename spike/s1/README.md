# Spike S1: CI feasibility (throwaway)

This branch exists only to answer the unknowns listed in `docs/PHASE-1.md` §5 (S1) on a real macOS 27
GitHub runner. It is never merged. Its findings go into `docs/DECISIONS.md`.

| Script | Question |
|---|---|
| `link-up.sh` / `link-down.sh` | Can `feth` pairs plus pf `rdr` (and optionally `reply-to`) act as a fake link to a non-local server address? Does dummynet shape them? |
| `server.mjs` | Range-capable HTTP test server that reports which source address each request came from. |
| `bind.mjs` | Can Node pin a socket to an interface with `IP_BOUND_IF` via koffi on darwin, the way Plexo does on Linux? |
| `fakevpn/` | Can a test helper act like a VPN (utun plus `0/1` and `128/1` routes)? Do the routes vanish on `kill -9`? |
| `gatekeeper.sh` | What does Gatekeeper do with a quarantined ad-hoc-signed app on the runner? |
| `launchd.sh` | Does a system LaunchDaemon with `KeepAlive` restart after `kill -9`? |
