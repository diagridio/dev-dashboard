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
		"./target/release/app":    "unknown",
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
		"saga-primes-go":                      "unknown",
		"":                                    "unknown",
	}
	for image, want := range tests {
		if got := InferRuntimeFromImage(image); got != want {
			t.Fatalf("InferRuntimeFromImage(%q) = %q, want %q", image, got, want)
		}
	}
}
