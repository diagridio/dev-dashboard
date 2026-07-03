//go:build unit

package controlplane

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func fakeLook(present map[string]bool) lookPathFunc {
	return func(bin string) (string, error) {
		if present[bin] {
			return "/usr/bin/" + bin, nil
		}
		return "", errors.New("not found")
	}
}

func TestResolveRuntime(t *testing.T) {
	both := fakeLook(map[string]bool{"docker": true, "podman": true})
	onlyPodman := fakeLook(map[string]bool{"podman": true})
	none := fakeLook(map[string]bool{})

	if got := resolveRuntime("", both); got != RuntimeDocker {
		t.Errorf("both present: got %q, want docker", got)
	}
	if got := resolveRuntime("", onlyPodman); got != RuntimePodman {
		t.Errorf("only podman: got %q, want podman", got)
	}
	if got := resolveRuntime("", none); got != RuntimeNone {
		t.Errorf("none present: got %q, want empty", got)
	}
	// Env override wins, even when the other runtime is on PATH.
	if got := resolveRuntime("podman", both); got != RuntimePodman {
		t.Errorf("env override: got %q, want podman", got)
	}
	// Invalid env override is ignored and falls back to PATH probing.
	if got := resolveRuntime("nerdctl", both); got != RuntimeDocker {
		t.Errorf("invalid env override: got %q, want docker", got)
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
	ch, err := r.stream(context.Background(), "-c", "echo out; echo err 1>&2")
	if err != nil {
		t.Fatalf("stream: %v", err)
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
	ch, err := r.stream(ctx, "-c", "echo first; sleep 30")
	if err != nil {
		t.Fatalf("stream: %v", err)
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
	ch, err := r.stream(ctx, "-c", "echo first; sleep 30 & wait")
	if err != nil {
		t.Fatalf("stream: %v", err)
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
	ch, err := r.stream(context.Background(), "-c", `head -c 2097152 /dev/zero | tr '\0' 'a'; echo`)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	got := collect(t, ch, 10*time.Second)
	if len(got) == 0 || !strings.HasPrefix(got[len(got)-1], "[stream error:") {
		t.Errorf("stream lines = %v, want final \"[stream error: ...]\" line", got)
	}
}

// run must include the command's stderr in the returned error, not just
// "exit status 1", so the API surfaces why an action failed.
func TestExecRunnerRunErrorIncludesStderr(t *testing.T) {
	r := &execRunner{bin: "sh"}
	_, err := r.run(context.Background(), "-c", "echo boom 1>&2; exit 1")
	if err == nil {
		t.Fatal("run: got nil error, want failure")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error = %q, want stderr detail %q included", err, "boom")
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		t.Errorf("error = %v, want *exec.ExitError still reachable via errors.As", err)
	}
}

// run without stderr output keeps the plain error.
func TestExecRunnerRunErrorNoStderr(t *testing.T) {
	r := &execRunner{bin: "sh"}
	_, err := r.run(context.Background(), "-c", "exit 3")
	if err == nil {
		t.Fatal("run: got nil error, want failure")
	}
	if got := err.Error(); got != "exit status 3" {
		t.Errorf("error = %q, want %q", got, "exit status 3")
	}
}
