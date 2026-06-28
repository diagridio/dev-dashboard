//go:build unit

package cmd

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUpdateCmdRegistered(t *testing.T) {
	c := NewRootCmd()
	sub, _, err := c.Find([]string{"update"})
	require.NoError(t, err)
	require.Equal(t, "update", sub.Name())
}

func TestUpdateCmdArgValidation(t *testing.T) {
	c := newUpdateCmd()
	require.NoError(t, c.Args(c, []string{}))
	require.NoError(t, c.Args(c, []string{"1.2.0"}))
	require.Error(t, c.Args(c, []string{"1.2.0", "extra"}))
}
