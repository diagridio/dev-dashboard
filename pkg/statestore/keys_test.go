//go:build unit

package statestore

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkflowActorType(t *testing.T) {
	require.Equal(t, "dapr.internal.default.order.workflow", WorkflowActorType("default", "order"))
}

func TestPatterns(t *testing.T) {
	require.Equal(t, "order||dapr.internal.default.order.workflow||%||metadata", InstanceMetaPattern("default", "order"))
	require.Equal(t, "order||dapr.internal.default.order.workflow||abc||", InstancePrefix("default", "order", "abc"))
	require.Equal(t, "order||dapr.internal.default.order.workflow||abc||%", InstanceKeyPattern("default", "order", "abc"))
}

func TestParseInstanceID(t *testing.T) {
	id, ok := ParseInstanceID("order||dapr.internal.default.order.workflow||abc-123||metadata")
	require.True(t, ok)
	require.Equal(t, "abc-123", id)

	_, ok = ParseInstanceID("too||few")
	require.False(t, ok)

	_, ok = ParseInstanceID("a||b||||metadata")
	require.False(t, ok)
}
