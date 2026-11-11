# mergelane-daemon

The root helper that merges every internet link the Mac has, system-wide. It started as an import of
[Net Merge](https://github.com/rohit267/net-merge) (MIT, Copyright (c) 2026 Rohit Mahto); see
`../docs/UPSTREAM.md` for the exact commit and what Mergelane changed.

How it works: a `utun` interface with `0.0.0.0/1` and `128.0.0.0/1` capture routes sends the Mac's traffic into
a user-space TCP/IP stack (gVisor, through tun2socks). Each new flow is dialled out through one physical link,
pinned with `IP_BOUND_IF`, and links are weighted by measured throughput.

Requirements: macOS 27 or later on Apple silicon, Go 1.27.

```sh
go build ./cmd/mergelane-daemon
go vet ./... && staticcheck ./...
go test -race ./...
```

`run` and `cleanup` need root. Never run `run` on a Mac you rely on without reading `../docs/PHASE-1.md` §8
(recovery) first.
