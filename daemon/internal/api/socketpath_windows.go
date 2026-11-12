package api

// SocketPath is the daemon's named pipe on Windows (ADR-0059). Its security descriptor (PipeSDDL),
// not its name, decides who may use it.
const SocketPath = `\\.\pipe\mergelane-daemon`
