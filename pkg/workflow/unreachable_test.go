//go:build unit

package workflow

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUnreachableService(t *testing.T) {
	svc := NewUnreachableService("statestore", "localhost:16379")

	_, listErr := svc.List(context.Background(), ListQuery{})
	_, statsErr := svc.Stats(context.Background(), ListQuery{})
	_, getErr := svc.Get(context.Background(), "order", "abc")

	for name, err := range map[string]error{"List": listErr, "Stats": statsErr, "Get": getErr} {
		require.Error(t, err, "%s should error", name)
		require.True(t, errors.Is(err, ErrStoreUnreachable), "%s wraps ErrStoreUnreachable", name)
		require.True(t, strings.Contains(err.Error(), "statestore"), "%s message names the store", name)
		require.True(t, strings.Contains(err.Error(), "localhost:16379"), "%s message includes the connection", name)
	}
}
