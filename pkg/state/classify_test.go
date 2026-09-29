//go:build unit

package state

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		appID   string
		logical string
		kind    Kind
	}{
		{
			name: "bare key (component sets keyPrefix: none)",
			key:  "order-42", appID: "", logical: "order-42", kind: KindApp,
		},
		{
			name: "app-prefixed key",
			key:  "myapp||order-42", appID: "myapp", logical: "order-42", kind: KindApp,
		},
		{
			name:  "workflow metadata key",
			key:   "myapp||dapr.internal.default.myapp.workflow||abc123||metadata",
			appID: "myapp", logical: "dapr.internal.default.myapp.workflow||abc123||metadata",
			kind: KindWorkflow,
		},
		{
			name:  "workflow history key",
			key:   "myapp||dapr.internal.default.myapp.workflow||abc123||history-000001",
			appID: "myapp", logical: "dapr.internal.default.myapp.workflow||abc123||history-000001",
			kind: KindWorkflow,
		},
		{
			name:  "activity actor key is also runtime-internal",
			key:   "myapp||dapr.internal.default.myapp.activity||abc123::0||metadata",
			appID: "myapp", logical: "dapr.internal.default.myapp.activity||abc123::0||metadata",
			kind: KindWorkflow,
		},
		{
			name:  "user actor state",
			key:   "myapp||MyActor||actor-7||balance",
			appID: "myapp", logical: "MyActor||actor-7||balance", kind: KindActor,
		},
		{
			name:  "app key whose logical name contains the delimiter is misclassified (documented heuristic)",
			key:   "myapp||weird||name",
			appID: "myapp", logical: "weird||name", kind: KindActor,
		},
		{
			name: "empty prefix segment yields no app id",
			key:  "||order-42", appID: "", logical: "order-42", kind: KindApp,
		},
		{
			name: "empty key",
			key:  "", appID: "", logical: "", kind: KindApp,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classify(tc.key)
			require.Equal(t, tc.appID, got.AppID)
			require.Equal(t, tc.logical, got.LogicalKey)
			require.Equal(t, tc.kind, got.Kind)
		})
	}
}
