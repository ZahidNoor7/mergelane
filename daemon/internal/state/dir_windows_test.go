package state

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/ZahidNoor7/mergelane/daemon/internal/platform"
)

// aces lists an ACL's entries (GetAce, as x/sys/windows' own tests read them).
func aces(t *testing.T, acl *windows.ACL) []*windows.ACCESS_ALLOWED_ACE {
	t.Helper()
	out := make([]*windows.ACCESS_ALLOWED_ACE, acl.AceCount)
	for i := range out {
		if err := windows.GetAce(acl, uint32(i), &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func aceSID(ace *windows.ACCESS_ALLOWED_ACE) *windows.SID {
	return (*windows.SID)(unsafe.Pointer(&ace.SidStart))
}

// As administrator (the service; GitHub's runners, ADR-0075), Prepare makes the folder and gives it
// StateDirSDDL's owner and entries, with the parent's permissions not inherited, every time it runs.
func TestPrepareSecuresTheDirectory(t *testing.T) {
	if !platform.IsAdmin() {
		t.Skip("setting the owner needs administrator rights")
	}
	dir := filepath.Join(t.TempDir(), "a", "b")
	for range 2 {
		if err := Prepare(dir); err != nil {
			t.Fatal(err)
		}
	}
	got, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	want, err := windows.SecurityDescriptorFromString(StateDirSDDL)
	if err != nil {
		t.Fatal(err)
	}

	owner, _, err := got.Owner()
	if err != nil {
		t.Fatal(err)
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	if !owner.Equals(admins) {
		t.Errorf("owner = %v, want Administrators", owner)
	}

	control, _, err := got.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Error("the folder inherits its parent's permissions")
	}

	gotDACL, _, err := got.DACL()
	if err != nil {
		t.Fatal(err)
	}
	wantDACL, _, err := want.DACL()
	if err != nil {
		t.Fatal(err)
	}
	gotACEs, wantACEs := aces(t, gotDACL), aces(t, wantDACL)
	if len(gotACEs) != len(wantACEs) {
		t.Fatalf("%d entries, want %d (%s)", len(gotACEs), len(wantACEs), got)
	}
	for i, w := range wantACEs {
		g := gotACEs[i]
		if g.Header.AceType != w.Header.AceType || g.Header.AceFlags != w.Header.AceFlags || g.Mask != w.Mask ||
			!aceSID(g).Equals(aceSID(w)) {
			t.Errorf("entry %d = %v %#x %#x %v, want %v %#x %#x %v", i, g.Header.AceType, g.Header.AceFlags, g.Mask,
				aceSID(g), w.Header.AceType, w.Header.AceFlags, w.Mask, aceSID(w))
		}
	}
}

func TestPrepareUnderAFileFails(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(filepath.Join(file, "x")); err == nil {
		t.Fatal("Prepare under a regular file must fail")
	}
}
