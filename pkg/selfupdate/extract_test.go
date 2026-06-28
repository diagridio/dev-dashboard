//go:build unit

package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"testing"

	"github.com/stretchr/testify/require"
)

func makeTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	require.NoError(t, tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content))}))
	_, err := tw.Write(content)
	require.NoError(t, err)
	require.NoError(t, tw.Close())
	require.NoError(t, gz.Close())
	return buf.Bytes()
}

func makeZip(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	require.NoError(t, err)
	_, err = w.Write(content)
	require.NoError(t, err)
	require.NoError(t, zw.Close())
	return buf.Bytes()
}

func TestExtractBinaryTarGz(t *testing.T) {
	content := []byte("fake-linux-binary")
	archive := makeTarGz(t, "dev-dashboard", content)
	got, err := extractBinary(archive, "linux")
	require.NoError(t, err)
	require.Equal(t, content, got)
}

func TestExtractBinaryZip(t *testing.T) {
	content := []byte("fake-windows-binary")
	archive := makeZip(t, "dev-dashboard.exe", content)
	got, err := extractBinary(archive, "windows")
	require.NoError(t, err)
	require.Equal(t, content, got)
}

func TestExtractBinaryMissing(t *testing.T) {
	archive := makeTarGz(t, "some-other-file", []byte("x"))
	_, err := extractBinary(archive, "linux")
	require.Error(t, err)
}
