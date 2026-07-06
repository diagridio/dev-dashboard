//go:build unit

package containerruntime

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestResolve(t *testing.T) {
	found := func(string) (string, error) { return "/usr/bin/x", nil }
	notFound := func(string) (string, error) { return "", errors.New("not found") }
	onlyPodman := func(bin string) (string, error) {
		if bin == "podman" {
			return "/usr/bin/podman", nil
		}
		return "", errors.New("not found")
	}

	if got := Resolve("docker", notFound); got != Docker {
		t.Fatalf("env override docker: got %q", got)
	}
	if got := Resolve("podman", notFound); got != Podman {
		t.Fatalf("env override podman: got %q", got)
	}
	if got := Resolve("", found); got != Docker {
		t.Fatalf("docker preferred: got %q", got)
	}
	if got := Resolve("", onlyPodman); got != Podman {
		t.Fatalf("podman fallback: got %q", got)
	}
	if got := Resolve("", notFound); got != None {
		t.Fatalf("none: got %q", got)
	}
	if got := Resolve("nonsense", notFound); got != None {
		t.Fatalf("invalid env ignored: got %q", got)
	}
}

func TestDetectNilRunnerWhenNone(t *testing.T) {
	// When Detect returns Kind==None, the Runner must be nil.
	// We can't force the environment in a unit test, but we can at least
	// verify Detect returns a consistent pair by checking type assertions.
	kind, run := Detect()
	if kind == None && run != nil {
		t.Fatalf("Detect: kind=None but runner is non-nil")
	}
	if kind != None && run == nil {
		t.Fatalf("Detect: kind=%q but runner is nil", kind)
	}
}

// collect drains ch until it closes or the timeout elapses.
func collect(t *testing.T, ch <-chan string, timeout time.Duration) []string {
	t.Helper()
	var got []string
	deadline := time.After(timeout)
	for {
		select {
		case line, open := <-ch:
			if !open {
				return got
			}
			got = append(got, line)
		case <-deadline:
			t.Fatalf("stream did not close within %v; got %v", timeout, got)
		}
	}
}

// The runtime CLI demultiplexes container output: container stdout goes to the
// CLI's stdout, container stderr to the CLI's stderr. Both must reach the log
// stream, along with CLI errors like "no such container".
func TestExecRunnerStreamCapturesStderr(t *testing.T) {
	r := &execRunner{bin: "sh"}
	ch, err := r.Stream(context.Background(), "-c", "echo out; echo err 1>&2")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := collect(t, ch, 5*time.Second)
	joined := strings.Join(got, "\n")
	if !strings.Contains(joined, "out") {
		t.Errorf("stream lines = %v, want stdout line %q", got, "out")
	}
	if !strings.Contains(joined, "err") {
		t.Errorf("stream lines = %v, want stderr line %q", got, "err")
	}
}

// Cancelling the handler context must kill the child and close the channel,
// even while the child is still producing (or sleeping).
func TestExecRunnerStreamCancelEndsStream(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &execRunner{bin: "sh"}
	ch, err := r.Stream(ctx, "-c", "echo first; sleep 30")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	select {
	case line := <-ch:
		if line != "first" {
			t.Fatalf("first line = %q, want %q", line, "first")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no line before cancel")
	}
	cancel()
	collect(t, ch, 5*time.Second) // fails if the channel never closes
}

// Shells fork rather than exec non-tail commands, and cancellation kills only
// the direct child: a surviving descendant still holds a duplicate of the pipe
// write end, so EOF alone would never come. `sleep 30 & wait` forces that fork
// on every platform; the stream must still close promptly after cancel.
func TestExecRunnerStreamCancelWithSurvivingGrandchild(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &execRunner{bin: "sh"}
	ch, err := r.Stream(ctx, "-c", "echo first; sleep 30 & wait")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	select {
	case line := <-ch:
		if line != "first" {
			t.Fatalf("first line = %q, want %q", line, "first")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no line before cancel")
	}
	cancel()
	collect(t, ch, 5*time.Second) // fails if the channel never closes
}

// A scanner error (e.g. a line exceeding the buffer cap) must not look like a
// normal EOF; it is surfaced as a final marker line.
func TestExecRunnerStreamSurfacesScannerError(t *testing.T) {
	r := &execRunner{bin: "sh"}
	// Print a single line larger than the 1 MiB scanner cap.
	ch, err := r.Stream(context.Background(), "-c", `head -c 2097152 /dev/zero | tr '\0' 'a'; echo`)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := collect(t, ch, 10*time.Second)
	if len(got) == 0 || !strings.HasPrefix(got[len(got)-1], "[stream error:") {
		t.Errorf("stream lines = %v, want final \"[stream error: ...]\" line", got)
	}
}

// Run must include the command's stderr in the returned error, not just
// "exit status 1", so the API surfaces why an action failed.
func TestExecRunnerRunErrorIncludesStderr(t *testing.T) {
	r := &execRunner{bin: "sh"}
	_, err := r.Run(context.Background(), "-c", "echo boom 1>&2; exit 1")
	if err == nil {
		t.Fatal("Run: got nil error, want failure")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error = %q, want stderr detail %q included", err, "boom")
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Errorf("error = %v, want *exec.ExitError still reachable via errors.As", err)
	}
}

// Run without stderr output keeps the plain error.
func TestExecRunnerRunErrorNoStderr(t *testing.T) {
	r := &execRunner{bin: "sh"}
	_, err := r.Run(context.Background(), "-c", "exit 3")
	if err == nil {
		t.Fatal("Run: got nil error, want failure")
	}
	if got := err.Error(); got != "exit status 3" {
		t.Errorf("error = %q, want %q", got, "exit status 3")
	}
}
