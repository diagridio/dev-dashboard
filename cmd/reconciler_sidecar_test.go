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
				if got[i].AppID != tc.want[i].AppID || got[i].Addr != tc.want[i].Addr {
					t.Fatalf("endpoint %d: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
