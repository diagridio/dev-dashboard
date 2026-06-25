//go:build unit

package cmd

import (
	"testing"

	"github.com/stretchr/testify/require"
)

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
