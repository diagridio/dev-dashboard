// Package containerruntime resolves the local container runtime (docker or
// podman) and executes its CLI. Shared by pkg/controlplane and pkg/discovery.
package containerruntime

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Kind identifies the resolved container runtime.
type Kind string

const (
	Docker Kind = "docker"
	Podman Kind = "podman"
	None   Kind = ""
)

// Runner executes runtime subcommands: Run returns stdout; Stream emits lines.
type Runner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
	Stream(ctx context.Context, args ...string) (<-chan string, error)
}

// Resolve picks the container runtime: an explicit valid env override, else
// docker (preferred) then podman via look, else None.
func Resolve(env string, look func(string) (string, error)) Kind {
	switch Kind(env) {
	case Docker, Podman:
		return Kind(env)
	}
	if _, err := look(string(Docker)); err == nil {
		return Docker
	}
	if _, err := look(string(Podman)); err == nil {
		return Podman
	}
	return None
}

// Detect resolves from DASH_CONTAINER_RUNTIME + PATH. Runner is nil when Kind
// is None.
func Detect() (Kind, Runner) {
	kind := Resolve(os.Getenv("DASH_CONTAINER_RUNTIME"), exec.LookPath)
	if kind == None {
		return None, nil
	}
	return kind, NewExecRunner(kind)
}

// execRunner runs the resolved runtime binary via os/exec.
type execRunner struct{ bin string }

// NewExecRunner returns a Runner invoking the kind's CLI binary.
func NewExecRunner(kind Kind) Runner { return &execRunner{bin: string(kind)} }

func (r *execRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, r.bin, args...).Output()
	// Output() stashes stderr in ExitError.Stderr; fold it into the error so
	// the API reports why the command failed, not just "exit status 1".
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if detail := strings.TrimSpace(string(ee.Stderr)); detail != "" {
			return out, fmt.Errorf("%w: %s", err, detail)
		}
	}
	return out, err
}

func (r *execRunner) Stream(ctx context.Context, args ...string) (<-chan string, error) {
	cmd := exec.CommandContext(ctx, r.bin, args...)
	// The runtime CLI demultiplexes container output: container stdout goes
	// to the CLI's stdout, container stderr to the CLI's stderr. Attach one
	// pipe to both so error output (and CLI errors like "no such container")
	// reaches the stream, interleaved like a terminal.
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, err
	}
	// The child holds its own copy of the write end; close ours so the
	// scanner sees EOF once the child exits.
	pw.Close()
	ch := make(chan string)
	// Cancellation kills only the direct child, but shells fork non-tail
	// commands: a surviving descendant keeps a duplicate of the write end,
	// so waiting for EOF alone would block the scanner forever. Close the
	// read end on cancel to unblock it regardless of surviving writers.
	// (Double-closing pr with the scanner goroutine's deferred Close is safe.)
	scanDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			pr.Close()
		case <-scanDone:
		}
	}()
	go func() {
		defer close(ch)
		defer close(scanDone)
		defer func() { _ = cmd.Wait() }()
		// Closing the read end before Wait unblocks a child stuck writing
		// (e.g. after a scanner error mid-line), so Wait cannot deadlock.
		defer pr.Close()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			select {
			case ch <- sc.Text():
			case <-ctx.Done():
				_ = cmd.Process.Kill()
				return
			}
		}
		// A scanner error (e.g. a line over the buffer cap) would otherwise
		// look like a normal EOF; surface it as a final marker line.
		if err := sc.Err(); err != nil {
			select {
			case ch <- fmt.Sprintf("[stream error: %v]", err):
			case <-ctx.Done():
			}
		}
	}()
	return ch, nil
}
