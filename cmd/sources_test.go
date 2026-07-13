//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
)

func TestSourcesFor(t *testing.T) {
	tests := []struct {
		name     string
		mode     Mode
		contract bool
		want     sourceSet
	}{
		{name: "default scans everything", mode: ModeDefault,
			want: sourceSet{Standalone: true, Compose: true, Testcontainers: true}},
		{name: "default joins the env contract when present", mode: ModeDefault, contract: true,
			want: sourceSet{Standalone: true, Compose: true, Testcontainers: true, AspireContract: true}},
		{name: "dapr-run is standalone only", mode: ModeDaprRun,
			want: sourceSet{Standalone: true}},
		{name: "compose is compose only and needs a runtime", mode: ModeCompose,
			want: sourceSet{Compose: true, NeedsRuntime: true}},
		{name: "test-containers is tc only and needs a runtime", mode: ModeTestcontainers,
			want: sourceSet{Testcontainers: true, NeedsRuntime: true}},
		{name: "aspire host filters the standalone scan", mode: ModeAspire,
			want: sourceSet{Standalone: true, AspireFilter: true}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := sourcesFor(tc.mode, tc.contract); got != tc.want {
				t.Fatalf("sourcesFor(%q,%v)=%+v want %+v", tc.mode, tc.contract, got, tc.want)
			}
		})
	}
}

func TestCPSourcesFor(t *testing.T) {
	tests := []struct {
		mode Mode
		want controlplane.Sources
	}{
		{ModeDefault, controlplane.AllSources()},
		{ModeDaprRun, controlplane.Sources{Init: true}},
		{ModeAspire, controlplane.Sources{Init: true}},
		{ModeCompose, controlplane.Sources{Compose: true}},
		{ModeTestcontainers, controlplane.Sources{}},
	}
	for _, tc := range tests {
		if got := cpSourcesFor(tc.mode); got != tc.want {
			t.Fatalf("cpSourcesFor(%q)=%+v want %+v", tc.mode, got, tc.want)
		}
	}
}
