package controlplane

import (
	"context"
	"os/exec"
)

// runner executes a single runtime subcommand and returns its stdout.
type runner interface {
	run(ctx context.Context, args ...string) ([]byte, error)
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
