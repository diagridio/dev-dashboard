//go:build unit

package workflow

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestUnreachableService(t *testing.T) {
	svc := NewUnreachableService("statestore", "localhost:16379", nil)

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

func TestUnreachableService_ReportsCause(t *testing.T) {
	tests := []struct {
		name, conn string
		cause      error
		want       string
	}{
		{
			name:  "unsupported type is not called a connection failure",
			cause: fmt.Errorf("%w: state.sqlserver", statestore.ErrUnsupported),
			want:  `state store "statestore" can't be read directly: unsupported state store type: state.sqlserver`,
		},
		{
			name:  "connection failure keeps the connection and adds the cause",
			conn:  "localhost:16379",
			cause: errors.New("dial tcp 127.0.0.1:16379: connection refused"),
			want:  `could not connect to state store "statestore" (localhost:16379): dial tcp 127.0.0.1:16379: connection refused`,
		},
		{
			name:  "no empty parentheses without a connection summary",
			cause: errors.New("timeout"),
			want:  `could not connect to state store "statestore": timeout`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewUnreachableService("statestore", tc.conn, tc.cause).List(context.Background(), ListQuery{})
			require.ErrorIs(t, err, ErrStoreUnreachable)
			require.ErrorIs(t, err, tc.cause)
			require.Equal(t, tc.want, err.Error())
		})
	}
}
