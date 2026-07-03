package controlplane

import (
	"bufio"
	"context"
	"os/exec"
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
	return exec.CommandContext(ctx, r.bin, args...).Output()
}

func (r *execRunner) stream(ctx context.Context, args ...string) (<-chan string, error) {
	cmd := exec.CommandContext(ctx, r.bin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	ch := make(chan string)
	go func() {
		defer close(ch)
		defer func() { _ = cmd.Wait() }()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			select {
			case ch <- sc.Text():
			case <-ctx.Done():
				_ = cmd.Process.Kill()
				return
			}
		}
	}()
	return ch, nil
}
