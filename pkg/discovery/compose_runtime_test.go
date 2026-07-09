//go:build unit

package discovery

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// writeFile creates path (and parents) with content.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func TestRuntimeFromMarkerFiles(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  string
	}{
		{"go", []string{"go.mod"}, "go"},
		{"dotnet sln and global.json (dapr-mq layout)", []string{"DaprMQ.sln", "global.json", "NuGet.config"}, "dotnet"},
		{"dotnet csproj", []string{"App.csproj"}, "dotnet"},
		{"node", []string{"package.json"}, "node"},
		{"python", []string{"requirements.txt"}, "python"},
		{"java", []string{"pom.xml"}, "java"},
		{"rust", []string{"Cargo.toml"}, "rust"},
		{"priority: go.mod beats package.json", []string{"package.json", "go.mod"}, "go"},
		{"no markers", []string{"README.md"}, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range tc.files {
				writeFile(t, filepath.Join(dir, f), "x")
			}
			require.Equal(t, tc.want, runtimeFromMarkerFiles(dir))
		})
	}
	t.Run("nonexistent dir", func(t *testing.T) {
		require.Equal(t, "unknown", runtimeFromMarkerFiles(filepath.Join(t.TempDir(), "nope")))
	})
	t.Run("markers in subdirs do not count", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "src", "go.mod"), "x")
		require.Equal(t, "unknown", runtimeFromMarkerFiles(dir))
	})
}

func TestRuntimeFromBuildContext(t *testing.T) {
	t.Run("string build shorthand", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "dotnet", "global.json"), "{}")
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./dotnet\n")
		require.Equal(t, "dotnet", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("object build with context", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "svc", "go.mod"), "module x")
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build:\n      context: ./svc\n      dockerfile: Dockerfile\n")
		require.Equal(t, "go", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("service without build section (pulled image)", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    image: nginx\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("unknown service", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: .\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "other"))
	})
	// No comma in the subtest name: t.TempDir embeds the name in the path,
	// and a comma there would collide with the label's comma separator.
	t.Run("comma-separated config files - second resolves", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "app", "Cargo.toml"), "[package]")
		cf1 := filepath.Join(proj, "missing.yml") // does not exist
		cf2 := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf2, "services:\n  web:\n    build: ./app\n")
		require.Equal(t, "rust", runtimeFromBuildContext(cf1+","+cf2, proj, "web"))
	})
	t.Run("dangling context path", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./gone\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("invalid yaml", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services: [not: valid: yaml")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("empty inputs", func(t *testing.T) {
		require.Equal(t, "unknown", runtimeFromBuildContext("", "", "web"))
		require.Equal(t, "unknown", runtimeFromBuildContext("x.yml", "", ""))
	})
	t.Run("relative context resolved against workingDir not cwd", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "js", "package.json"), "{}")
		// compose file lives elsewhere; workingDir is the project dir
		other := t.TempDir()
		cf := filepath.Join(other, "compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./js\n")
		require.Equal(t, "node", runtimeFromBuildContext(cf, proj, "web"))
	})
}

func TestComposeAppRuntimeChainPrecedence(t *testing.T) {
	// Build-context fixture that would say "go" if reached.
	proj := t.TempDir()
	writeFile(t, filepath.Join(proj, "svc", "go.mod"), "module x")
	cf := filepath.Join(proj, "docker-compose.yml")
	writeFile(t, cf, "services:\n  web:\n    build: ./svc\n")

	base := composeContainer{Service: "web", ConfigFiles: cf, WorkingDir: proj}

	t.Run("argv beats everything", func(t *testing.T) {
		app := base
		app.Argv = []string{"dotnet", "App.dll"}
		app.Env = []string{"NODE_VERSION=22"}
		app.Image = "python:3.12"
		require.Equal(t, "dotnet", composeAppRuntime(app))
	})
	t.Run("env beats image and files", func(t *testing.T) {
		app := base
		app.Argv = []string{"/entrypoint.sh"}
		app.Env = []string{"NODE_VERSION=22"}
		app.Image = "python:3.12"
		require.Equal(t, "node", composeAppRuntime(app))
	})
	t.Run("image beats files", func(t *testing.T) {
		app := base
		app.Argv = []string{"/app/server"}
		app.Image = "python:3.12"
		require.Equal(t, "python", composeAppRuntime(app))
	})
	t.Run("build context is the last resort", func(t *testing.T) {
		app := base
		app.Argv = []string{"/app/server"}
		app.Image = "custom-app"
		require.Equal(t, "go", composeAppRuntime(app))
	})
	t.Run("all unknown", func(t *testing.T) {
		app := composeContainer{Service: "web", Argv: []string{"/app/server"}, Image: "custom-app"}
		require.Equal(t, "unknown", composeAppRuntime(app))
	})
}
