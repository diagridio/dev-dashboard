//go:build unit

package controlplane

import (
	"errors"
	"testing"
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
