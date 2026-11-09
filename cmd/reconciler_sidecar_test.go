//go:build unit

package cmd

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// workflowEndpoint keeps the table below readable.
type workflowEndpoint = workflow.SidecarEndpoint

func TestSidecarEndpointsAddressResolution(t *testing.T) {
	tests := []struct {
		name       string
		instances  []discovery.Instance
		includeAll bool
		want       []workflowEndpoint
	}{
		{
			name: "host posture still uses loopback",
			instances: []discovery.Instance{
				{AppID: "tc-app", Source: discovery.SourceTestcontainers, GRPCPort: 58445},
			},
			want: []workflowEndpoint{{AppID: "tc-app", Addr: "127.0.0.1:58445"}},
		},
		{
			name: "contract compose app uses its in-network address",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: true},
			},
			want: []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001"}},
		},
		{
			name: "contract compose app is eligible even when includeAll is false",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: true},
			},
			includeAll: false,
			want:       []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001"}},
		},
		{
			// With an openable store, an unreachable contract sidecar is not
			// sidecar-owned: the store serves its workflows instead.
			name: "unreachable contract compose app defers to the store",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: false},
			},
			includeAll: false,
			want:       nil,
		},
		{
			// With no openable store the sidecar is the only possible source,
			// so the contract app stays eligible even while unreachable.
			name: "unreachable contract compose app stays eligible without a store",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: false},
			},
			includeAll: true,
			// Flagged so all-apps reads skip it without dialing.
			want: []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001", Unreachable: true}},
		},
		{
			name: "contract app's gRPC TLS flag is carried to the endpoint",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", DaprGRPCTLS: true, SidecarReachable: true},
			},
			want: []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001", TLS: true}},
		},
		{
			name: "host compose app without a gRPC port is skipped",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, SidecarReachable: true},
			},
			includeAll: true,
			want:       nil,
		},
		{
			name: "aspire apps stay excluded",
			instances: []discovery.Instance{
				{AppID: "aspire-app", Source: discovery.SourceAspire, GRPCPort: 50001, SidecarReachable: true},
			},
			includeAll: true,
			want:       nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rc := &reconciler{apps: staticApps{instances: tc.instances}}
			got := rc.sidecarEndpoints(tc.includeAll)(context.Background())
			if len(got) != len(tc.want) {
				t.Fatalf("got %d endpoints %v, want %d", len(got), got, len(tc.want))
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("endpoint %d: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
