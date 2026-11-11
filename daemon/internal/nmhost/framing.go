package nmhost

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// MaxMessageBytes is the largest message the host reads from the browser, writes to the browser, or
// relays from the app. Chrome allows 1 MiB host → browser and 64 MiB browser → host; no bridge message
// needs more than 1 MiB, so the host refuses more in both directions (docs/BROWSER-BRIDGE.md).
const MaxMessageBytes = 1 << 20

// ErrTooBig reports a message longer than MaxMessageBytes.
var ErrTooBig = errors.New("nmhost: message is over 1 MiB")

// ReadMessage reads one native messaging frame: a 32-bit length in native byte order, then that many
// bytes. It returns io.EOF, unwrapped, only when r ends cleanly before a frame starts. A frame cut
// short gives an error wrapping io.ErrUnexpectedEOF, and a length over MaxMessageBytes one wrapping
// ErrTooBig, read before any of the body. After either, the stream cannot be resynchronised.
func ReadMessage(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if err == io.EOF {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("nmhost: reading a message length: %w", err)
	}
	n := binary.NativeEndian.Uint32(hdr[:])
	if n > MaxMessageBytes {
		return nil, fmt.Errorf("%w (%d bytes)", ErrTooBig, n)
	}
	msg := make([]byte, n)
	if _, err := io.ReadFull(r, msg); err != nil {
		if err == io.EOF { // nothing of the body arrived
			err = io.ErrUnexpectedEOF
		}
		return nil, fmt.Errorf("nmhost: reading a %d-byte message: %w", n, err)
	}
	return msg, nil
}

// WriteMessage writes msg as one native messaging frame, in a single Write so that a reader never
// sees a length without its body. It writes nothing and returns an error wrapping ErrTooBig when msg
// is longer than MaxMessageBytes.
func WriteMessage(w io.Writer, msg []byte) error {
	if len(msg) > MaxMessageBytes {
		return fmt.Errorf("%w (%d bytes)", ErrTooBig, len(msg))
	}
	frame := make([]byte, 4+len(msg))
	binary.NativeEndian.PutUint32(frame, uint32(len(msg)))
	copy(frame[4:], msg)
	_, err := w.Write(frame)
	return err
}
