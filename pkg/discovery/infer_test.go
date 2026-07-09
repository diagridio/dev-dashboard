//go:build unit

package discovery

import "testing"
import "github.com/stretchr/testify/require"

func TestInferRuntime(t *testing.T) {
	cases := map[string]string{
		"go run ./cmd/app":        "go",
		"/usr/bin/python3 app.py": "python",
		"python app.py":           "python",
		"node server.js":          "node",
		"npm run start":           "node",
		"dotnet run":              "dotnet",
		"java -jar app.jar":       "java",
		"cargo run":               "rust",
		"./target/release/app":    "rust",
		"./target/debug/app":      "rust",
		"":                        "unknown",
	}
	for cmd, want := range cases {
		t.Run(cmd, func(t *testing.T) { require.Equal(t, want, InferRuntime(cmd)) })
	}
}

func TestInferRuntimeFromImage(t *testing.T) {
	tests := map[string]string{
		"golang:1.24":                         "go",
		"python:3.12-slim":                    "python",
		"node:22-alpine":                      "node",
		"mcr.microsoft.com/dotnet/aspnet:9.0": "dotnet",
		"eclipse-temurin:21":                  "java",
		"openjdk:21":                          "java",
		"rust:1.75-slim":                      "rust",
		"saga-primes-go":                      "unknown",
		"":                                    "unknown",
	}
	for image, want := range tests {
		if got := InferRuntimeFromImage(image); got != want {
			t.Fatalf("InferRuntimeFromImage(%q) = %q, want %q", image, got, want)
		}
	}
}

func TestInferRuntimeFromEnv(t *testing.T) {
	tests := []struct {
		name string
		env  []string
		want string
	}{
		{"dotnet version", []string{"PATH=/usr/bin", "DOTNET_VERSION=10.0.9"}, "dotnet"},
		{"aspnet version", []string{"ASPNET_VERSION=10.0.9"}, "dotnet"},
		{"node", []string{"NODE_VERSION=22.1.0"}, "node"},
		{"python", []string{"PYTHON_VERSION=3.12.4"}, "python"},
		{"java version", []string{"JAVA_VERSION=21"}, "java"},
		{"java home", []string{"JAVA_HOME=/opt/java"}, "java"},
		{"golang", []string{"GOLANG_VERSION=1.23.4"}, "go"},
		{"rust", []string{"RUST_VERSION=1.79"}, "rust"},
		{"cargo home", []string{"CARGO_HOME=/usr/local/cargo"}, "rust"},
		{"no markers", []string{"PATH=/usr/bin", "HOME=/root"}, "unknown"},
		{"empty", nil, "unknown"},
		{"value not name", []string{"FOO=NODE_VERSION"}, "unknown"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, InferRuntimeFromEnv(tc.env)) })
	}
}
