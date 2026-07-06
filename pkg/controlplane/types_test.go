//go:build unit

package controlplane

import "testing"

func TestIsLiveName(t *testing.T) {
	if !IsLiveName("dapr_scheduler") {
		t.Error("scheduler should be live")
	}
	if IsLiveName("dapr_sentry") {
		t.Error("sentry is not a self-hosted control-plane container")
	}
}

func TestValidAction(t *testing.T) {
	for _, a := range []string{"start", "stop", "restart"} {
		if !ValidAction(a) {
			t.Errorf("ValidAction(%q) should be true", a)
		}
	}
	for _, a := range []string{"", "kill", "rm", "pause"} {
		if ValidAction(a) {
			t.Errorf("ValidAction(%q) should be false", a)
		}
	}
}
