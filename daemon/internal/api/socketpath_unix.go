//go:build !windows

package api

// SocketPath is where the daemon listens (ADR-0005).
const SocketPath = "/var/run/mergelane/daemon.sock"
