//go:build unit

package discovery

import (
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeResolver struct {
	cmd string
	ok  bool
}

func (f fakeResolver) CommandForPort(int) (string, bool) { return f.cmd, f.ok }

func TestAppRuntime(t *testing.T) {
	t.Run("known primary command — no fallback needed", func(t *testing.T) {
		// Resolver would return python, but primary already resolves to dotnet.
		got := appRuntime("dotnet run", 5467, fakeResolver{cmd: "python app.py", ok: true})
		require.Equal(t, "dotnet", got)
	})

	t.Run("empty command, fallback resolves dotnet from app port", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{cmd: "/usr/bin/dotnet MyApp.dll", ok: true})
		require.Equal(t, "dotnet", got)
	})

	t.Run("empty command, no app port — stays unknown", func(t *testing.T) {
		got := appRuntime("", 0, fakeResolver{cmd: "dotnet x", ok: true})
		require.Equal(t, "unknown", got)
	})

	t.Run("empty command, resolver miss — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{ok: false})
		require.Equal(t, "unknown", got)
	})

	t.Run("nil resolver — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, nil)
		require.Equal(t, "unknown", got)
	})

	t.Run("fallback command also unknown — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{cmd: "./mystery-binary", ok: true})
		require.Equal(t, "unknown", got)
	})
}
