//go:build unit

package cmd

import (
	"bytes"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

func TestVersionFlag(t *testing.T) {
	c := NewRootCmd()
	var buf bytes.Buffer
	c.SetOut(&buf)
	c.SetArgs([]string{"--version"})
	require.NoError(t, c.Execute())
	out := buf.String()
	require.Contains(t, out, version.Get().Version)
	require.Contains(t, out, "dev-dashboard")
	require.Contains(t, out, "commit none")
	require.Contains(t, out, "built unknown")
}

func TestRootDefaults(t *testing.T) {
	c := NewRootCmd()
	port, err := c.Flags().GetInt("port")
	require.NoError(t, err)
	require.Equal(t, 9090, port)

	noOpen, err := c.Flags().GetBool("no-open")
	require.NoError(t, err)
	require.False(t, noOpen)

	base, err := c.Flags().GetString("base-path")
	require.NoError(t, err)
	require.Equal(t, "", base)
}

func TestRootCmd_HasVerboseFlag(t *testing.T) {
	c := NewRootCmd()
	f := c.Flags().Lookup("verbose")
	if f == nil {
		t.Fatal("expected --verbose flag to be registered")
	}
	if f.DefValue != "false" {
		t.Fatalf("expected --verbose default false, got %q", f.DefValue)
	}
}
