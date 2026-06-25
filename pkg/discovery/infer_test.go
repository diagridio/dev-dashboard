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
