package nmhost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The app, the test kit and the host must name the same pipe for a folder: all three are tested against
// shared/fixtures/browser-pipe.json.
func TestPipeNameMatchesTheSharedExamples(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "fixtures", "browser-pipe.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct{ UserData, Pipe string }
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Cases) < 3 {
		t.Fatalf("only %d examples", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		if got := PipeName(c.UserData); got != c.Pipe {
			t.Errorf("PipeName(%q) = %q, want %q", c.UserData, got, c.Pipe)
		}
	}
}

func TestASCIILowerLeavesOtherLettersAlone(t *testing.T) {
	if got := asciiLower(`C:\Users\ZOË`); got != `c:\users\zoË` {
		t.Errorf("asciiLower = %q", got)
	}
}
