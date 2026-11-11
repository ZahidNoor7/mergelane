package launchd

import (
	"bytes"
	"encoding/xml"
	"strconv"
)

// The XML declaration and DOCTYPE are the ones in the example in launchd.plist(5).
const (
	plistHead = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`
	plistTail = "</dict>\n</plist>\n"
)

// PlistXML returns the launchd.plist(5) job definition for the daemon installed at p, allowing uid to control
// it. Every key below is documented in launchd.plist(5) on macOS 27.0.1:
//
//   - Label: "This required key uniquely identifies the job to launchd."
//   - ProgramArguments: the argv. Its first element is the absolute binary path, which the man page allows in
//     the absence of Program. The daemon runs as `run --allowed-uid <uid>` (ADR-0005).
//   - RunAtLoad true: start as soon as the job is bootstrapped (KeepAlive also implies it).
//   - KeepAlive true: "unconditionally keep the job alive" (ADR-0007).
//   - ThrottleInterval 1: the default is "not ... spawned more than once every 10 seconds"; ADR-0017 measured a
//     1 s restart with 1.
//   - ProcessType Interactive: the man page says an unset or Standard type gets "light resource limits ...,
//     throttling its CPU usage and I/O bandwidth", and Interactive is for jobs an app's responsiveness depends
//     on that "cannot be made Adaptive". Every app's traffic passes through the daemon's user-space TCP/IP
//     stack while system merge is on, so throttling it throttles the whole Mac's network, and Adaptive needs
//     XPC transactions, which the daemon (a Unix-socket server) does not use.
//   - StandardOutPath and StandardErrorPath: both the log file; launchd creates it if missing (its directory
//     must exist, which Install ensures).
//   - AssociatedBundleIdentifiers: "If an app installs a legacy plist the plist should include this key with a
//     value of the app's bundle identifier", so System Settings › Login Items shows it under Mergelane.
func PlistXML(p Paths, uid int) ([]byte, error) {
	if err := validUID(uid); err != nil {
		return nil, err
	}
	var w plistWriter
	w.WriteString(plistHead)
	w.key("Label").str(Label)
	w.key("ProgramArguments").strs(p.Binary, "run", "--allowed-uid", strconv.Itoa(uid))
	w.key("RunAtLoad").yes()
	w.key("KeepAlive").yes()
	w.key("ThrottleInterval").integer(ThrottleInterval)
	w.key("ProcessType").str("Interactive")
	w.key("StandardOutPath").str(p.Log)
	w.key("StandardErrorPath").str(p.Log)
	w.key("AssociatedBundleIdentifiers").str(AppBundleID)
	w.WriteString(plistTail)
	return w.Bytes(), nil
}

// plistWriter writes the few plist(5) value types the job needs, one per line, indented by tabs.
type plistWriter struct{ bytes.Buffer }

func (w *plistWriter) elem(indent, tag, text string) {
	w.WriteString(indent + "<" + tag + ">")
	_ = xml.EscapeText(w, []byte(text)) // a bytes.Buffer never fails to write
	w.WriteString("</" + tag + ">\n")
}

func (w *plistWriter) key(k string) *plistWriter { w.elem("\t", "key", k); return w }
func (w *plistWriter) str(s string)              { w.elem("\t", "string", s) }
func (w *plistWriter) integer(n int)             { w.elem("\t", "integer", strconv.Itoa(n)) }

func (w *plistWriter) yes() { w.WriteString("\t<true/>\n") }

func (w *plistWriter) strs(ss ...string) {
	w.WriteString("\t<array>\n")
	for _, s := range ss {
		w.elem("\t\t", "string", s)
	}
	w.WriteString("\t</array>\n")
}
