//go:build unit

package controlplane

import "testing"

func TestIsControlPlaneName(t *testing.T) {
	cases := map[string]bool{
		"dapr_scheduler": true,
		"dapr_placement": true,
		"dapr_sentry":    true,
		"dapr_injector":  true,
		"dapr_redis":     false,
		"":               false,
		"scheduler":      false,
	}
	for name, want := range cases {
		if got := IsControlPlaneName(name); got != want {
			t.Errorf("IsControlPlaneName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestIsLiveName(t *testing.T) {
	if !IsLiveName("dapr_scheduler") {
		t.Error("scheduler should be live")
	}
	if IsLiveName("dapr_sentry") {
		t.Error("sentry is k8s-only, not live")
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
