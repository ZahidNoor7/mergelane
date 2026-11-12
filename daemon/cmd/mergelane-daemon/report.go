package main

import (
	"fmt"
	"os"
)

// writeReport records install's or uninstall's result for the app, which can't read an elevated
// program's output on Windows (app/src/shared/windowsHelper.ts elevationOutcome): "ok", or
// "error: <why>". The file must not exist yet (the app names a fresh one), so an elevated run never
// writes through a link left at that path.
func writeReport(path string, result error) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("report: %w", err)
	}
	text := "ok\n"
	if result != nil {
		text = "error: " + result.Error() + "\n"
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return fmt.Errorf("report: %w", err)
	}
	return f.Close()
}

// reported runs step and, when path isn't empty, writes its result there. The step's own error wins
// over a failure to write the report.
func reported(path string, step func() error) error {
	err := step()
	if path != "" {
		if werr := writeReport(path, err); werr != nil && err == nil {
			return werr
		}
	}
	return err
}
