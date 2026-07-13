//go:build unit

package discovery

import (
	"archive/tar"
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// buildTar assembles an in-memory tar the way `docker cp <id>:/dir -` does:
// a top-level directory entry followed by its files.
func buildTar(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	require.NoError(t, tw.WriteHeader(&tar.Header{
		Name: "dapr-resources/", Typeflag: tar.TypeDir, Mode: 0o755,
	}))
	for name, content := range entries {
		require.NoError(t, tw.WriteHeader(&tar.Header{
			Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(content)),
		}))
		_, err := tw.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, tw.Close())
	return buf.Bytes()
}

func TestExtractYAMLFromTar_KeepsOnlyYAMLFiles(t *testing.T) {
	data := buildTar(t, map[string]string{
		"dapr-resources/kvstore.yaml": "apiVersion: dapr.io/v1alpha1\nkind: Component\n",
		"dapr-resources/notes.txt":    "not yaml",
		"dapr-resources/cfg.yml":      "kind: Configuration\n",
	})
	files, err := extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Len(t, files, 2)
	require.Contains(t, string(files["dapr-resources/kvstore.yaml"]), "kind: Component")
	require.Contains(t, string(files["dapr-resources/cfg.yml"]), "kind: Configuration")
}

func TestExtractYAMLFromTar_Caps(t *testing.T) {
	big := strings.Repeat("x", maxExtractFileSize+1)
	data := buildTar(t, map[string]string{"dapr-resources/big.yaml": big})
	files, err := extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Empty(t, files) // oversized member skipped, not an error

	many := map[string]string{}
	for i := 0; i < maxExtractFiles+5; i++ {
		many[fmt.Sprintf("dapr-resources/c%03d.yaml", i)] = "kind: Component\n"
	}
	data = buildTar(t, many)
	files, err = extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Len(t, files, maxExtractFiles)
}

func TestExtractYAMLFromTar_GarbageInput(t *testing.T) {
	_, err := extractYAMLFromTar([]byte("this is not a tar archive"))
	require.Error(t, err)
}
