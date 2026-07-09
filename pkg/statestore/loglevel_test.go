//go:build unit

package statestore_test

import (
	"bytes"
	"context"
	"testing"

	"github.com/dapr/kit/logger"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// newSQLiteStore opens an in-memory sqlite store, whose components-contrib
// Init logs "Creating metadata table..." at INFO through the kit logger.
func newSQLiteStore(t *testing.T) {
	t.Helper()
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:     "statestore",
		Type:     "state.sqlite",
		Version:  "v1",
		Metadata: map[string]string{"connectionString": ":memory:"},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
}

// captureKitLog redirects the shared "dev-dashboard" kit logger into a buffer.
// The kit logger registry memoizes by name, so this is the same instance New uses.
func captureKitLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	logger.NewLogger("dev-dashboard").SetOutput(&buf)
	return &buf
}

func TestNew_QuietByDefault(t *testing.T) {
	statestore.SetVerbose(false)
	buf := captureKitLog(t)
	newSQLiteStore(t)
	require.NotContains(t, buf.String(), "Creating metadata table")
}

func TestNew_VerboseEmitsBackendInfoLogs(t *testing.T) {
	statestore.SetVerbose(true)
	t.Cleanup(func() { statestore.SetVerbose(false) })
	buf := captureKitLog(t)
	newSQLiteStore(t)
	require.Contains(t, buf.String(), "Creating metadata table")
}
