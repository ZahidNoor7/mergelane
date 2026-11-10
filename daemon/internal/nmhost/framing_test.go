package nmhost

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

// frame builds a frame by hand: length n in native byte order, then body (which may disagree with n).
func frame(n uint32, body []byte) []byte {
	b := binary.NativeEndian.AppendUint32(nil, n)
	return append(b, body...)
}

func TestFramingRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		size int
	}{
		{"zero length", 0},
		{"one byte", 1},
		{"small", 17},
		{"length needs two bytes", 258},
		{"one under the limit", MaxMessageBytes - 1},
		{"exactly the limit", MaxMessageBytes},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := bytes.Repeat([]byte{'x'}, tt.size)
			var buf bytes.Buffer
			if err := WriteMessage(&buf, msg); err != nil {
				t.Fatalf("WriteMessage: %v", err)
			}
			if buf.Len() != 4+tt.size {
				t.Fatalf("frame is %d bytes, want %d", buf.Len(), 4+tt.size)
			}
			if got := binary.NativeEndian.Uint32(buf.Bytes()[:4]); got != uint32(tt.size) {
				t.Errorf("length prefix = %d, want %d", got, tt.size)
			}
			got, err := ReadMessage(&buf)
			if err != nil {
				t.Fatalf("ReadMessage: %v", err)
			}
			if !bytes.Equal(got, msg) {
				t.Errorf("read back %d bytes, want the %d written", len(got), len(msg))
			}
			if _, err := ReadMessage(&buf); err != io.EOF {
				t.Errorf("after the only frame: err = %v, want io.EOF", err)
			}
		})
	}
}

func TestFramingIsLittleEndianOnAppleSilicon(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteMessage(&buf, make([]byte, 258)); err != nil {
		t.Fatal(err)
	}
	if got := buf.Bytes()[:4]; !bytes.Equal(got, []byte{2, 1, 0, 0}) {
		t.Errorf("prefix for 258 bytes = %v, want [2 1 0 0] (native order on arm64 is little endian)", got)
	}
}

func TestFramingSeveralFramesInOneStream(t *testing.T) {
	var buf bytes.Buffer
	msgs := []string{`{"type":"ping"}`, ``, `{"type":"wake"}`}
	for _, m := range msgs {
		if err := WriteMessage(&buf, []byte(m)); err != nil {
			t.Fatal(err)
		}
	}
	for i, want := range msgs {
		got, err := ReadMessage(&buf)
		if err != nil || string(got) != want {
			t.Fatalf("frame %d = %q, %v; want %q", i, got, err, want)
		}
	}
	if _, err := ReadMessage(&buf); err != io.EOF {
		t.Errorf("err = %v, want io.EOF", err)
	}
}

func TestWriteMessageRefusesOversize(t *testing.T) {
	for _, size := range []int{MaxMessageBytes + 1, 2 * MaxMessageBytes} {
		var buf bytes.Buffer
		err := WriteMessage(&buf, make([]byte, size))
		if !errors.Is(err, ErrTooBig) {
			t.Errorf("%d bytes: err = %v, want ErrTooBig", size, err)
		}
		if buf.Len() != 0 {
			t.Errorf("%d bytes: wrote %d bytes, want nothing", size, buf.Len())
		}
	}
}

type failingWriter struct{ err error }

func (w failingWriter) Write([]byte) (int, error) { return 0, w.err }

func TestWriteMessageReturnsWriteError(t *testing.T) {
	boom := errors.New("boom")
	if err := WriteMessage(failingWriter{boom}, []byte("{}")); !errors.Is(err, boom) {
		t.Errorf("err = %v, want boom", err)
	}
}

// errReader returns data, then err.
type errReader struct {
	data []byte
	err  error
}

func (r *errReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestReadMessageErrors(t *testing.T) {
	boom := errors.New("boom")
	tests := []struct {
		name    string
		in      io.Reader
		wantErr error
	}{
		{"empty stream", bytes.NewReader(nil), io.EOF},
		{"one byte of length", bytes.NewReader([]byte{1}), io.ErrUnexpectedEOF},
		{"three bytes of length", bytes.NewReader([]byte{1, 0, 0}), io.ErrUnexpectedEOF},
		{"length but no body", bytes.NewReader(frame(10, nil)), io.ErrUnexpectedEOF},
		{"body cut short", bytes.NewReader(frame(10, []byte("12345"))), io.ErrUnexpectedEOF},
		{"one over the limit", bytes.NewReader(frame(MaxMessageBytes+1, []byte("x"))), ErrTooBig},
		{"largest length", bytes.NewReader(frame(0xFFFFFFFF, nil)), ErrTooBig},
		{"error reading the length", &errReader{[]byte{1, 0}, boom}, boom},
		{"error reading the body", &errReader{frame(4, []byte("ab")), boom}, boom},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, err := ReadMessage(tt.in)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr == io.EOF && err != io.EOF {
				t.Errorf("a clean end must be io.EOF itself, got %#v", err)
			}
			if msg != nil {
				t.Errorf("msg = %q, want nil", msg)
			}
		})
	}
}
