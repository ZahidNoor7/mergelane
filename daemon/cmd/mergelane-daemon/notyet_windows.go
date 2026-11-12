package main

// On Windows, System merge (the service, its adapter and routes) is milestone W5 in
// docs/WINDOWS-PLAN.md. Until then the commands that would install or start it refuse, so nothing
// is written outside the user's own folders and no route is ever added. cleanup stays: it has
// nothing to remove, and must keep working for anyone who runs it after a crash.
func init() {
	const why = "System merge is not available on Windows yet"
	notYet = map[string]string{"run": why, "install": why, "uninstall": why}
}
