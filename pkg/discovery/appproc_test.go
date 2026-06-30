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
		got, isAspire := appRuntime("dotnet run", 5467, fakeResolver{cmd: "python app.py", ok: true})
		require.Equal(t, "dotnet", got)
		require.False(t, isAspire)
	})

	t.Run("empty command, fallback resolves dotnet from app port", func(t *testing.T) {
		got, isAspire := appRuntime("", 5467, fakeResolver{cmd: "/usr/bin/dotnet MyApp.dll", ok: true})
		require.Equal(t, "dotnet", got)
		require.False(t, isAspire)
	})

	t.Run("empty command, no app port — stays unknown", func(t *testing.T) {
		got, isAspire := appRuntime("", 0, fakeResolver{cmd: "dotnet x", ok: true})
		require.Equal(t, "unknown", got)
		require.False(t, isAspire)
	})

	t.Run("empty command, resolver miss — stays unknown", func(t *testing.T) {
		got, isAspire := appRuntime("", 5467, fakeResolver{ok: false})
		require.Equal(t, "unknown", got)
		require.False(t, isAspire)
	})

	t.Run("nil resolver — stays unknown", func(t *testing.T) {
		got, isAspire := appRuntime("", 5467, nil)
		require.Equal(t, "unknown", got)
		require.False(t, isAspire)
	})

	t.Run("fallback command also unknown — stays unknown", func(t *testing.T) {
		got, isAspire := appRuntime("", 5467, fakeResolver{cmd: "./mystery-binary", ok: true})
		require.Equal(t, "unknown", got)
		require.False(t, isAspire)
	})
}

func TestAppRuntime_AspireDcpProxyIsDotnet(t *testing.T) {
	dcp := "/Users/me/.nuget/packages/aspire.hosting.orchestration.osx-arm64/13.3.5/tools/dcp run-controllers --kubeconfig /var/folders/x/y"
	// daprd reports no app command; app port listener is the Aspire DCP proxy.
	got, isAspire := appRuntime("", 5467, fakeResolver{cmd: dcp, ok: true})
	require.Equal(t, "dotnet", got)
	require.True(t, isAspire)
}

func TestAppRuntime_GenericFallbackStillWinsBeforeAspire(t *testing.T) {
	// A real go app listening directly on its app port must still resolve to "go",
	// never reaching the Aspire branch.
	got, isAspire := appRuntime("", 5467, fakeResolver{cmd: "go run ./cmd/app", ok: true})
	require.Equal(t, "go", got)
	require.False(t, isAspire)
}

func TestIsAspireProxy(t *testing.T) {
	require.True(t, isAspireProxy("/x/.nuget/packages/aspire.hosting.orchestration.osx-arm64/13.3.5/tools/dcp run-controllers --kubeconfig /v"))
	require.True(t, isAspireProxy("/some/path/dcp run-controllers --kubeconfig /v"))
	require.False(t, isAspireProxy("dotnet run"))
	require.False(t, isAspireProxy("/usr/local/bin/dcp version")) // dcp without run-controllers
	require.False(t, isAspireProxy(""))
}
