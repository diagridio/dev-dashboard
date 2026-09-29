//go:build unit

package state

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEscapeLike(t *testing.T) {
	require.Equal(t, `order\_42`, escapeLike("order_42"))
	require.Equal(t, `100\%`, escapeLike("100%"))
	require.Equal(t, `a\\b`, escapeLike(`a\b`))
	require.Equal(t, "plain-key", escapeLike("plain-key"))
	require.Equal(t, "", escapeLike(""))
	// A trailing backslash must not leave a dangling escape in the pattern.
	require.Equal(t, `a\\`, escapeLike(`a\`))
}

func TestListPattern(t *testing.T) {
	t.Run("no filters matches every key", func(t *testing.T) {
		// KeysLike rejects an empty pattern, so the unfiltered case is "%".
		require.Equal(t, "%", listPattern("", ""))
	})
	t.Run("app filter becomes a prefix pattern", func(t *testing.T) {
		require.Equal(t, "myapp||%", listPattern("myapp", ""))
	})
	t.Run("search becomes a contains pattern", func(t *testing.T) {
		require.Equal(t, "%order%", listPattern("", "order"))
	})
	t.Run("app and search combine", func(t *testing.T) {
		require.Equal(t, "myapp||%order%", listPattern("myapp", "order"))
	})
	t.Run("search metacharacters are escaped so they match literally", func(t *testing.T) {
		require.Equal(t, `%order\_42%`, listPattern("", "order_42"))
	})
	t.Run("app id metacharacters are escaped too", func(t *testing.T) {
		// App ids come from parsed key text and can contain underscores.
		require.Equal(t, `my\_app||%`, listPattern("my_app", ""))
	})
}
