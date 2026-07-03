package controlplane

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// runner executes runtime subcommands: run returns stdout; stream emits lines.
type runner interface {
	run(ctx context.Context, args ...string) ([]byte, error)
	stream(ctx context.Context, args ...string) (<-chan string, error)
}

// lookPathFunc mirrors exec.LookPath; injectable for tests.
type lookPathFunc func(string) (string, error)

// resolveRuntime picks the container runtime: an explicit valid env override,
// else docker (preferred) then podman via look, else RuntimeNone.
func resolveRuntime(env string, look lookPathFunc) RuntimeKind {
	switch RuntimeKind(env) {
	case RuntimeDocker, RuntimePodman:
		return RuntimeKind(env)
	}
	if _, err := look(string(RuntimeDocker)); err == nil {
		return RuntimeDocker
	}
	if _, err := look(string(RuntimePodman)); err == nil {
		return RuntimePodman
	}
	return RuntimeNone
}

// execRunner runs the resolved runtime binary via os/exec.
type execRunner struct{ bin string }

func newExecRunner(kind RuntimeKind) *execRunner { return &execRunner{bin: string(kind)} }

func (r *execRunner) run(ctx context.Context, args ...string) ([]byte, error) {
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

func (r *execRunner) stream(ctx context.Context, args ...string) (<-chan string, error) {
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
	go func() {
		defer close(ch)
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
