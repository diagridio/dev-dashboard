//go:build unit

package workflow

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeStatus(t *testing.T) {
	cases := map[string]Status{
		"ORCHESTRATION_STATUS_RUNNING":          StatusRunning,
		"ORCHESTRATION_STATUS_CONTINUED_AS_NEW": StatusRunning,
		"ORCHESTRATION_STATUS_COMPLETED":        StatusCompleted,
		"ORCHESTRATION_STATUS_FAILED":           StatusFailed,
		"ORCHESTRATION_STATUS_TERMINATED":       StatusTerminated,
		"ORCHESTRATION_STATUS_CANCELED":         StatusTerminated,
		"ORCHESTRATION_STATUS_SUSPENDED":        StatusSuspended,
		"ORCHESTRATION_STATUS_PENDING":          StatusPending,
		"ORCHESTRATION_STATUS_STALLED":          StatusRunning,
		"something-unknown":                     StatusPending,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) { require.Equal(t, want, NormalizeStatus(raw)) })
	}
}

func TestExecutionJSONKeys(t *testing.T) {
	b, err := json.Marshal(Execution{
		ExecutionSummary: ExecutionSummary{AppID: "order", InstanceID: "abc", Status: StatusRunning},
		ReplayCount:      2,
		History:          []HistoryEvent{},
	})
	require.NoError(t, err)
	s := string(b)
	require.Contains(t, s, `"instanceId":"abc"`)
	require.Contains(t, s, `"status":"Running"`)
	require.Contains(t, s, `"replayCount":2`)
	require.Contains(t, s, `"history":[]`)
}
