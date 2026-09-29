//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
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
