package state

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// StateDirSDDL is the state directory's security on Windows: owned by Administrators, full control
// for SYSTEM (the service) and Administrators, read for every user (the app reads the log), and the
// parent's permissions not inherited (P), so a user who created the folder first can't keep write
// access to what the service reads. OICI passes it on to everything inside.
const StateDirSDDL = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)"

// windowsDir is %ProgramData%\Mergelane\daemon.
func windowsDir() string {
	base, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil || base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "Mergelane", "daemon")
}

// Prepare creates the state directory and sets its owner and permissions to StateDirSDDL every time,
// whoever made it first. Setting the owner needs administrator rights, which the service has.
func Prepare(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(StateDirSDDL)
	if err != nil {
		return fmt.Errorf("state directory security: %w", err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("state directory owner: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("state directory permissions: %w", err)
	}
	const info = windows.OWNER_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION |
		windows.PROTECTED_DACL_SECURITY_INFORMATION
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, info, owner, nil, dacl, nil); err != nil {
		return fmt.Errorf("securing %s: %w", dir, err)
	}
	return nil
}
