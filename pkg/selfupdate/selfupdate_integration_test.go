//go:build integration

package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// newFakeRelease builds a tar.gz containing a fake linux binary and returns the
// archive bytes plus a matching checksums.txt body.
func newFakeRelease(t *testing.T, binary []byte) (archive []byte, checksums string) {
	t.Helper()
	archive = makeTarGz(t, "dev-dashboard", binary) // helper from extract_test.go
	sum := sha256.Sum256(archive)
	name := "dev-dashboard_1.2.0_linux_amd64.tar.gz"
	checksums = hex.EncodeToString(sum[:]) + "  " + name + "\n"
	return archive, checksums
}

func newUpdater(t *testing.T, srvURL, current string) (*Updater, string) {
	t.Helper()
	exe := filepath.Join(t.TempDir(), "dev-dashboard")
	require.NoError(t, os.WriteFile(exe, []byte("old-binary"), 0o755))
	return &Updater{
		Repo:           "diagridio/dev-dashboard",
		APIBase:        srvURL,
		DownloadBase:   srvURL,
		HTTP:           &http.Client{},
		GOOS:           "linux",
		GOARCH:         "amd64",
		CurrentVersion: current,
		ExecPath:       exe,
		Out:            io.Discard,
	}, exe
}

func releaseServer(t *testing.T, archive []byte, checksums string, archiveStatus int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/releases/latest"):
			_, _ = w.Write([]byte(`{"tag_name":"v1.2.0"}`))
		case strings.HasSuffix(r.URL.Path, "/checksums.txt"):
			_, _ = w.Write([]byte(checksums))
		case strings.HasSuffix(r.URL.Path, ".tar.gz"):
			if archiveStatus != http.StatusOK {
				w.WriteHeader(archiveStatus)
				return
			}
			_, _ = w.Write(archive)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestRunHappyPath(t *testing.T) {
	binary := []byte("new-binary-v1.2.0")
	archive, checksums := newFakeRelease(t, binary)
	srv := releaseServer(t, archive, checksums, http.StatusOK)
	defer srv.Close()

	u, exe := newUpdater(t, srv.URL, "v1.0.0")
	res, err := u.Run(context.Background(), "")
	require.NoError(t, err)
	require.False(t, res.Skipped)
	require.Equal(t, "v1.2.0", res.To)

	got, err := os.ReadFile(exe)
	require.NoError(t, err)
	require.Equal(t, binary, got)
}

func TestRunAlreadyCurrent(t *testing.T) {
	archive, checksums := newFakeRelease(t, []byte("x"))
	srv := releaseServer(t, archive, checksums, http.StatusOK)
	defer srv.Close()

	u, exe := newUpdater(t, srv.URL, "v1.2.0")
	res, err := u.Run(context.Background(), "")
	require.NoError(t, err)
	require.True(t, res.Skipped)

	got, err := os.ReadFile(exe)
	require.NoError(t, err)
	require.Equal(t, []byte("old-binary"), got) // unchanged
}

func TestRunChecksumMismatch(t *testing.T) {
	archive, _ := newFakeRelease(t, []byte("new"))
	badChecksums := "0000  dev-dashboard_1.2.0_linux_amd64.tar.gz\n"
	srv := releaseServer(t, archive, badChecksums, http.StatusOK)
	defer srv.Close()

	u, exe := newUpdater(t, srv.URL, "v1.0.0")
	_, err := u.Run(context.Background(), "")
	require.Error(t, err)

	got, err := os.ReadFile(exe)
	require.NoError(t, err)
	require.Equal(t, []byte("old-binary"), got) // not replaced
}

func TestRunVersionNotFound(t *testing.T) {
	archive, checksums := newFakeRelease(t, []byte("new"))
	srv := releaseServer(t, archive, checksums, http.StatusNotFound)
	defer srv.Close()

	u, _ := newUpdater(t, srv.URL, "v1.0.0")
	_, err := u.Run(context.Background(), "9.9.9")
	require.Error(t, err)
	require.Contains(t, err.Error(), "not found")
}
