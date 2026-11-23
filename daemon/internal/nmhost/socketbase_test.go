package nmhost

import (
	"os"
	"runtime"
)

// socketBase is where the tests' Unix sockets go: /tmp on macOS, whose per-user $TMPDIR is too long for sun_path
// (104 bytes in <sys/un.h>); the temporary folder on Windows, which has no /tmp and takes Unix sockets since
// Windows 10 (version 1803).
func socketBase() string {
	if runtime.GOOS == "windows" {
		return os.TempDir()
	}
	return "/tmp"
}
