//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
)

func TestContractSource(t *testing.T) {
	tests := []struct {
		mode Mode
		want string
	}{
		{mode: ModeCompose, want: discovery.SourceCompose},
		{mode: ModeAspire, want: discovery.SourceAspire},
	}
	for _, tc := range tests {
		t.Run(string(tc.mode), func(t *testing.T) {
			if got := contractSource(tc.mode); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestAnyGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{
			name: "one declared app derives an address",
			env: map[string]string{
				"DEVDASHBOARD_APP_COUNT":       "1",
				"DEVDASHBOARD_APP_0_ID":        "order",
				"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://order-dapr:3500",
			},
			want: true,
		},
		{
			name: "zero apps has no address",
			env:  map[string]string{"DEVDASHBOARD_APP_COUNT": "0"},
			want: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			scan, err := discovery.NewContractScanner(getenv, discovery.SourceCompose)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := anyGRPCAddr(scan); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestWorkflowsEnabled(t *testing.T) {
	tests := []struct {
		name     string
		mode     Mode
		storeSet bool
		anyGRPC  bool
		want     bool
	}{
		{"aspire apps no store", ModeAspire, false, true, false},
		{"compose apps no store", ModeCompose, false, true, true},
		{"compose no apps no store", ModeCompose, false, false, false},
		{"aspire with store", ModeAspire, true, true, true},
		{"compose with store", ModeCompose, true, false, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := workflowsEnabled(tc.mode, tc.storeSet, tc.anyGRPC); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

// TestContainerCapabilities pins the whole capability set per container
// posture: only Workflows/State can ever be on, lifecycle, control plane,
// logs and secret reveal are always off, and ContainerPosture is always set.
func TestContainerCapabilities(t *testing.T) {
	oneApp := map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://order-dapr:3500",
	}
	noApps := map[string]string{"DEVDASHBOARD_APP_COUNT": "0"}
	tests := []struct {
		name     string
		mode     Mode
		env      map[string]string
		storeSet bool
		want     server.Capabilities
	}{
		{"compose, app, no store", ModeCompose, oneApp, false,
			server.Capabilities{Workflows: true, Mode: "compose", ContainerPosture: true}},
		{"compose, no apps, no store", ModeCompose, noApps, false,
			server.Capabilities{Mode: "compose", ContainerPosture: true}},
		{"compose, app, store", ModeCompose, oneApp, true,
			server.Capabilities{Workflows: true, State: true, Mode: "compose", ContainerPosture: true}},
		{"aspire, app, no store", ModeAspire, oneApp, false,
			server.Capabilities{Mode: "aspire", ContainerPosture: true}},
		{"aspire, app, store", ModeAspire, oneApp, true,
			server.Capabilities{Workflows: true, State: true, Mode: "aspire", ContainerPosture: true}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			scan, err := discovery.NewContractScanner(func(k string) string { return tc.env[k] }, contractSource(tc.mode))
			if err != nil {
				t.Fatalf("scanner: %v", err)
			}
			got := containerCapabilities(tc.mode, tc.storeSet, scan)
			if got == nil || *got != tc.want {
				t.Fatalf("got %+v\nwant %+v", got, tc.want)
			}
		})
	}
}
