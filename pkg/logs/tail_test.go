//go:build unit

package logs

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTailBackfillAndAppend(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	require.NoError(t, os.WriteFile(path, []byte("line1\nline2\n"), 0o600))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := Tail(ctx, path, 10, 20*time.Millisecond)
	require.NoError(t, err)

	require.Equal(t, "line1", recv(t, ch))
	require.Equal(t, "line2", recv(t, ch))

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, _ = f.WriteString("line3\n")
	_ = f.Close()

	require.Equal(t, "line3", recv(t, ch))
}

func TestTailBackfillLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.log")
	require.NoError(t, os.WriteFile(path, []byte("a\nb\nc\nd\n"), 0o600))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := Tail(ctx, path, 2, 20*time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, "c", recv(t, ch)) // only last 2 backfilled
	require.Equal(t, "d", recv(t, ch))
}

func TestTailMissingFile(t *testing.T) {
	_, err := Tail(context.Background(), "/no/such/file.log", 1, time.Second)
	require.Error(t, err)
}

func recv(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case s, ok := <-ch:
		require.True(t, ok, "channel closed early")
		return s
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for line")
		return ""
	}
}
