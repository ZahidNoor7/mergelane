package main

import (
	"runtime"

	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
)

// elevated says whether the tests run as root (macOS) or as an elevated administrator (Windows, as on GitHub's
// runners, ADR-0075): a command that refuses other users can't be shown refusing then. os.Geteuid is -1 on
// Windows, whoever runs.
func elevated() bool { return platform.IsAdmin() }

// What the system says for a path through a regular file, and for a folder that doesn't exist. Windows says both
// with ERROR_PATH_NOT_FOUND: "The system cannot find the path specified."
var notADirectory, noSuchFile = func() (string, string) {
	if runtime.GOOS == "windows" {
		return "cannot find the path specified", "cannot find the path specified"
	}
	return "not a directory", "no such file or directory"
}()
