package api

import (
	"fmt"
	"regexp"
)

// userSID matches the security identifiers of user accounts that may be allowed on the daemon's pipe:
// local and domain accounts (S-1-5-21-<domain>-<RID>) and Microsoft Entra ID accounts
// (S-1-12-1-<four parts>), as Microsoft Learn's "Security identifiers" and Entra examples show them.
// Well-known groups such as Everyone (S-1-1-0) or Users (S-1-5-32-545) never match, so the pipe can't
// be opened to everyone by mistake.
var userSID = regexp.MustCompile(`^S-1-(5-21|12-1)-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}$`)

// PipeSDDL is the security descriptor of the daemon's named pipe on Windows (ListenPipe, ADR-0059):
// full control for SYSTEM (the service itself) and Administrators, read and write for the one user the
// app installed the daemon for, and nothing inherited (P). Windows checks it before a connection
// exists, which on Windows takes the place of macOS's LOCAL_PEERCRED uid check.
func PipeSDDL(sid string) (string, error) {
	if !userSID.MatchString(sid) {
		return "", fmt.Errorf("api: %q is not a user account's security identifier", sid)
	}
	return "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + sid + ")", nil
}
