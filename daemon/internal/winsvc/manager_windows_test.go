package winsvc

import "testing"

// The service's command line is quoted the way CreateService quotes it, so a path with spaces stays
// one argument.
func TestCommandLine(t *testing.T) {
	got := commandLine(`C:\Program Files\Mergelane\mergelane-daemon.exe`, []string{"run", "--log", `C:\ProgramData\Mergelane\daemon\daemon.log`})
	want := `"C:\Program Files\Mergelane\mergelane-daemon.exe" run --log C:\ProgramData\Mergelane\daemon\daemon.log`
	if got != want {
		t.Errorf("commandLine = %s, want %s", got, want)
	}
	if len(Recovery) == 0 || Recovery[0].Delay.Seconds() > 5 || ResetPeriod != 86400 {
		t.Errorf("recovery: %v, reset %d", Recovery, ResetPeriod)
	}
}
