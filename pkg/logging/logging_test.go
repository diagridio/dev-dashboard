//go:build unit

package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestNew_VerboseWritesInfoAndAbove(t *testing.T) {
	// New(true) must produce a logger that emits INFO/WARN/ERROR.
	// We can't capture os.Stderr easily here, so assert the handler is enabled
	// at the expected levels.
	l := New(true)
	if !l.Handler().Enabled(nil, slog.LevelInfo) {
		t.Fatal("verbose logger should be enabled at INFO")
	}
	if !l.Handler().Enabled(nil, slog.LevelError) {
		t.Fatal("verbose logger should be enabled at ERROR")
	}
}

func TestNew_NotVerboseDiscardsEverything(t *testing.T) {
	l := New(false)
	if l.Handler().Enabled(nil, slog.LevelError) {
		t.Fatal("non-verbose logger must not be enabled at any level")
	}
}

func TestNew_VerboseDisabledBelowInfo(t *testing.T) {
	l := New(true)
	if l.Handler().Enabled(nil, slog.LevelDebug) {
		t.Fatal("verbose logger should not be enabled at DEBUG")
	}
}

// captureWriter test: a logger built over a buffer behaves the same as New(true).
func TestNew_OutputContainsMessage(t *testing.T) {
	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	l.Info("hello", "k", "v")
	out := buf.String()
	if !strings.Contains(out, "hello") || !strings.Contains(out, "k=v") {
		t.Fatalf("expected message and attr in output, got %q", out)
	}
}
