# dev-dashboard self-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `dev-dashboard update [version]` subcommand that downloads, verifies, and installs a newer (or specific) release of the binary over itself.

**Architecture:** A new std-lib-only domain package `pkg/selfupdate` holds all logic as small, independently-testable functions (version resolution, asset naming, checksum verification, archive extraction, atomic binary replacement), orchestrated by an `Updater.Run` method. `cmd/update.go` is a thin Cobra wrapper registered on the root command. No `pkg → cmd` dependency, matching the rest of the codebase.

**Tech Stack:** Go 1.26, standard library only (`net/http`, `archive/tar`, `archive/zip`, `compress/gzip`, `crypto/sha256`), Cobra for the CLI, `testify/require` + `net/http/httptest` for tests.

## Global Constraints

- Go ≥ 1.26; **standard library only** — no new third-party dependencies.
- Source repo is the compile-time constant `diagridio/dev-dashboard` (not user-overridable on the CLI).
- Release asset names MUST match the GoReleaser `name_template` exactly: `dev-dashboard_{num}_{os}_{arch}` where `num` is the version without a leading `v`; extension `.tar.gz` everywhere except Windows (`.zip`). The binary inside the archive is `dev-dashboard` (`dev-dashboard.exe` on Windows), at the archive root.
- Checksums are verified against the release's `checksums.txt` (GoReleaser format: `<sha256-hex>  <filename>` per line) **before** the binary is replaced. A mismatch aborts with no change.
- Current build version comes from `version.Get().Version` (a `dev`/`go install` build reports `dev`).
- Unit tests are gated `//go:build unit`; integration tests `//go:build integration`. Use `testify/require`.
- No code signing in v1. No confirmation prompt. Progress prints to the injected `Out` writer (stderr in production).

---

### Task 1: Version normalization & equality helpers

**Files:**
- Create: `pkg/selfupdate/resolve.go`
- Test: `pkg/selfupdate/resolve_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func normalizeVersion(v string) string`, `func versionsEqual(a, b string) bool`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/resolve_test.go`:

```go
//go:build unit

package selfupdate

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeVersion(t *testing.T) {
	require.Equal(t, "v1.2.0", normalizeVersion("1.2.0"))
	require.Equal(t, "v1.2.0", normalizeVersion("v1.2.0"))
	require.Equal(t, "v1.2.0", normalizeVersion(" v1.2.0 "))
	require.Equal(t, "", normalizeVersion(""))
}

func TestVersionsEqual(t *testing.T) {
	require.True(t, versionsEqual("1.2.0", "v1.2.0"))
	require.True(t, versionsEqual("v1.2.0", "v1.2.0"))
	require.False(t, versionsEqual("1.2.0", "1.2.1"))
	require.False(t, versionsEqual("dev", "v1.2.0"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run 'TestNormalizeVersion|TestVersionsEqual' -v`
Expected: FAIL — `undefined: normalizeVersion` (package does not compile yet).

- [ ] **Step 3: Write minimal implementation**

Create `pkg/selfupdate/resolve.go`:

```go
// Package selfupdate updates the dev-dashboard binary in place from GitHub Releases.
package selfupdate

import "strings"

// normalizeVersion ensures a single leading "v" and trims surrounding space.
// "1.2.0" -> "v1.2.0"; " v1.2.0 " -> "v1.2.0"; "" -> "".
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}

// versionsEqual reports whether a and b name the same version, ignoring a
// leading "v" and surrounding space.
func versionsEqual(a, b string) bool {
	return strings.TrimPrefix(strings.TrimSpace(a), "v") ==
		strings.TrimPrefix(strings.TrimSpace(b), "v")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run 'TestNormalizeVersion|TestVersionsEqual' -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/resolve.go pkg/selfupdate/resolve_test.go
git commit -m "feat(selfupdate): version normalization and equality helpers"
```

---

### Task 2: Release asset naming

**Files:**
- Create: `pkg/selfupdate/asset.go`
- Test: `pkg/selfupdate/asset_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func assetName(version, goos, goarch string) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/asset_test.go`:

```go
//go:build unit

package selfupdate

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAssetName(t *testing.T) {
	require.Equal(t, "dev-dashboard_1.2.0_linux_amd64.tar.gz", assetName("v1.2.0", "linux", "amd64"))
	require.Equal(t, "dev-dashboard_1.2.0_linux_arm64.tar.gz", assetName("1.2.0", "linux", "arm64"))
	require.Equal(t, "dev-dashboard_1.2.0_darwin_amd64.tar.gz", assetName("v1.2.0", "darwin", "amd64"))
	require.Equal(t, "dev-dashboard_1.2.0_darwin_arm64.tar.gz", assetName("v1.2.0", "darwin", "arm64"))
	require.Equal(t, "dev-dashboard_1.2.0_windows_amd64.zip", assetName("v1.2.0", "windows", "amd64"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestAssetName -v`
Expected: FAIL — `undefined: assetName`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/selfupdate/asset.go`:

```go
package selfupdate

import (
	"fmt"
	"strings"
)

// assetName reproduces the GoReleaser name_template for a release archive:
//
//	dev-dashboard_{num}_{os}_{arch}.tar.gz   (.zip on windows)
//
// where num is the version without a leading "v".
func assetName(version, goos, goarch string) string {
	num := strings.TrimPrefix(strings.TrimSpace(version), "v")
	ext := "tar.gz"
	if goos == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("dev-dashboard_%s_%s_%s.%s", num, goos, goarch, ext)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestAssetName -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/asset.go pkg/selfupdate/asset_test.go
git commit -m "feat(selfupdate): release asset naming matching goreleaser"
```

---

### Task 3: Checksum verification

**Files:**
- Create: `pkg/selfupdate/download.go`
- Test: `pkg/selfupdate/checksum_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func verifyChecksum(archive []byte, name, checksumsTxt string) error`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/checksum_test.go`:

```go
//go:build unit

package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestVerifyChecksum(t *testing.T) {
	archive := []byte("the archive bytes")
	sum := sha256.Sum256(archive)
	hexSum := hex.EncodeToString(sum[:])
	name := "dev-dashboard_1.2.0_linux_amd64.tar.gz"
	checksums := "deadbeef  other-file.zip\n" + hexSum + "  " + name + "\n"

	require.NoError(t, verifyChecksum(archive, name, checksums))

	// Wrong hash for our file.
	bad := "0000  " + name + "\n"
	require.Error(t, verifyChecksum(archive, name, bad))

	// No entry for our file.
	require.Error(t, verifyChecksum(archive, name, "deadbeef  other-file.zip\n"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestVerifyChecksum -v`
Expected: FAIL — `undefined: verifyChecksum`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/selfupdate/download.go`:

```go
package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// verifyChecksum computes the SHA256 of archive and matches it against the line
// for name in a GoReleaser checksums.txt ("<hex>  <name>" per line). It returns
// an error on mismatch or when no entry for name exists.
func verifyChecksum(archive []byte, name, checksumsTxt string) error {
	sum := sha256.Sum256(archive)
	got := hex.EncodeToString(sum[:])
	for _, line := range strings.Split(checksumsTxt, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if fields[1] == name {
			if fields[0] == got {
				return nil
			}
			return fmt.Errorf("checksum mismatch for %s: got %s, want %s", name, got, fields[0])
		}
	}
	return fmt.Errorf("no checksum entry for %s", name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestVerifyChecksum -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/download.go pkg/selfupdate/checksum_test.go
git commit -m "feat(selfupdate): verify archive SHA256 against checksums.txt"
```

---

### Task 4: Archive extraction (tar.gz + zip)

**Files:**
- Create: `pkg/selfupdate/extract.go`
- Test: `pkg/selfupdate/extract_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func extractBinary(archive []byte, goos string) ([]byte, error)`, `func binaryFileName(goos string) string`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/extract_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestExtractBinary -v`
Expected: FAIL — `undefined: extractBinary`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/selfupdate/extract.go`:

```go
package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
)

// binaryFileName returns the name of the dev-dashboard binary inside a release
// archive for the given OS.
func binaryFileName(goos string) string {
	if goos == "windows" {
		return "dev-dashboard.exe"
	}
	return "dev-dashboard"
}

// extractBinary pulls the dev-dashboard binary bytes out of a release archive:
// a .zip on windows, a .tar.gz elsewhere.
func extractBinary(archive []byte, goos string) ([]byte, error) {
	name := binaryFileName(goos)
	if goos == "windows" {
		return extractFromZip(archive, name)
	}
	return extractFromTarGz(archive, name)
}

func extractFromTarGz(archive []byte, name string) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if hdr.Name == name {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("binary %q not found in archive", name)
}

func extractFromZip(archive []byte, name string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}
	for _, f := range zr.File {
		if f.Name == name {
			rc, err := f.Open()
			if err != nil {
				return nil, fmt.Errorf("open zip entry: %w", err)
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, fmt.Errorf("binary %q not found in archive", name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestExtractBinary -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/extract.go pkg/selfupdate/extract_test.go
git commit -m "feat(selfupdate): extract binary from tar.gz and zip archives"
```

---

### Task 5: Atomic executable replacement

**Files:**
- Create: `pkg/selfupdate/replace.go`
- Test: `pkg/selfupdate/replace_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func replaceExecutable(path string, newBin []byte) error`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/replace_test.go`:

```go
//go:build unit

package selfupdate

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReplaceExecutable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev-dashboard")
	require.NoError(t, os.WriteFile(path, []byte("old-binary"), 0o755))

	require.NoError(t, replaceExecutable(path, []byte("new-binary")))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, []byte("new-binary"), got)

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o755), info.Mode().Perm())
	}
}

func TestReplaceExecutableBadDir(t *testing.T) {
	err := replaceExecutable(filepath.Join("definitely-missing-dir-xyz", "bin"), []byte("x"))
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestReplaceExecutable -v`
Expected: FAIL — `undefined: replaceExecutable`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/selfupdate/replace.go`:

```go
package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// replaceExecutable atomically replaces the file at path with newBin (mode
// 0755). On Unix it renames a temp file (written in the same directory) over
// the target, which is permitted even while the binary is running. On Windows
// the in-use target cannot be overwritten, so it is moved aside first and
// restored if the install fails.
func replaceExecutable(path string, newBin []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".dev-dashboard-update-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed away

	if _, err := tmp.Write(newBin); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp binary: %w", err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return fmt.Errorf("chmod temp binary: %w", err)
	}

	if runtime.GOOS == "windows" {
		old := path + ".old"
		_ = os.Remove(old)
		if err := os.Rename(path, old); err != nil {
			return fmt.Errorf("move current binary aside: %w", err)
		}
		if err := os.Rename(tmpName, path); err != nil {
			_ = os.Rename(old, path) // restore the original on failure
			return fmt.Errorf("install new binary: %w", err)
		}
		_ = os.Remove(old) // best effort; may be locked while running
		return nil
	}

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("install new binary: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run TestReplaceExecutable -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/replace.go pkg/selfupdate/replace_test.go
git commit -m "feat(selfupdate): atomic in-place executable replacement"
```

---

### Task 6: HTTP fetch + latest-version resolution

**Files:**
- Modify: `pkg/selfupdate/download.go` (add `httpGet` + `errNotFound`)
- Modify: `pkg/selfupdate/resolve.go` (add `resolveLatest`)
- Create: `pkg/selfupdate/fetch_test.go`

**Interfaces:**
- Consumes: `normalizeVersion` (Task 1).
- Produces: `var errNotFound error`; `func httpGet(ctx context.Context, client *http.Client, url string) ([]byte, error)`; `func resolveLatest(ctx context.Context, client *http.Client, apiBase, repo string) (string, error)`.

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/fetch_test.go`:

```go
//go:build unit

package selfupdate

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHTTPGetOKAndNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ok" {
			_, _ = w.Write([]byte("body-bytes"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	body, err := httpGet(context.Background(), srv.Client(), srv.URL+"/ok")
	require.NoError(t, err)
	require.Equal(t, []byte("body-bytes"), body)

	_, err = httpGet(context.Background(), srv.Client(), srv.URL+"/missing")
	require.ErrorIs(t, err, errNotFound)
}

func TestResolveLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/repos/diagridio/dev-dashboard/releases/latest", r.URL.Path)
		_, _ = w.Write([]byte(`{"tag_name":"v1.2.0"}`))
	}))
	defer srv.Close()

	v, err := resolveLatest(context.Background(), srv.Client(), srv.URL, "diagridio/dev-dashboard")
	require.NoError(t, err)
	require.Equal(t, "v1.2.0", v)
}

func TestResolveLatestEmptyTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	_, err := resolveLatest(context.Background(), srv.Client(), srv.URL, "diagridio/dev-dashboard")
	require.Error(t, err)
	require.False(t, errors.Is(err, errNotFound))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/selfupdate/ -run 'TestHTTPGet|TestResolveLatest' -v`
Expected: FAIL — `undefined: httpGet` / `undefined: resolveLatest`.

- [ ] **Step 3: Write minimal implementation**

Append to `pkg/selfupdate/download.go` (add imports `context`, `errors`, `io`, `net/http` to the existing import block):

```go
// errNotFound is returned by httpGet when the server responds 404.
var errNotFound = errors.New("not found")

// httpGet fetches url and returns the response body, mapping a 404 to
// errNotFound and any other non-200 status to an error.
func httpGet(ctx context.Context, client *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %s", url, resp.Status)
	}
	return io.ReadAll(resp.Body)
}
```

> The full import block of `download.go` after this step is:
> `crypto/sha256`, `encoding/hex`, `context`, `errors`, `fmt`, `io`, `net/http`, `strings`.

Append to `pkg/selfupdate/resolve.go` (add imports `context`, `encoding/json`, `fmt`, `net/http` to the existing import block):

```go
// resolveLatest queries the GitHub releases API for repo's latest tag_name and
// returns it normalized (with a leading "v").
func resolveLatest(ctx context.Context, client *http.Client, apiBase, repo string) (string, error) {
	url := fmt.Sprintf("%s/repos/%s/releases/latest", apiBase, repo)
	body, err := httpGet(ctx, client, url)
	if err != nil {
		return "", fmt.Errorf("resolve latest release: %w", err)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return "", fmt.Errorf("parse latest release: %w", err)
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("latest release has no tag_name")
	}
	return normalizeVersion(rel.TagName), nil
}
```

> The full import block of `resolve.go` after this step is: `context`, `encoding/json`, `fmt`, `net/http`, `strings`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/selfupdate/ -run 'TestHTTPGet|TestResolveLatest' -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/download.go pkg/selfupdate/resolve.go pkg/selfupdate/fetch_test.go
git commit -m "feat(selfupdate): HTTP fetch helper and latest-version resolution"
```

---

### Task 7: Updater orchestration (`Run`)

**Files:**
- Create: `pkg/selfupdate/selfupdate.go`
- Test: `pkg/selfupdate/selfupdate_integration_test.go`

**Interfaces:**
- Consumes: `resolveLatest`, `httpGet`, `errNotFound`, `normalizeVersion`, `versionsEqual`, `assetName`, `verifyChecksum`, `extractBinary`, `replaceExecutable` (Tasks 1–6); `version.Get()`.
- Produces:
  - `type Updater struct { Repo, APIBase, DownloadBase string; HTTP *http.Client; GOOS, GOARCH, CurrentVersion, ExecPath string; Out io.Writer }`
  - `type Result struct { From, To string; Skipped bool }`
  - `func New() (*Updater, error)`
  - `func (u *Updater) Run(ctx context.Context, requested string) (Result, error)`

- [ ] **Step 1: Write the failing test**

Create `pkg/selfupdate/selfupdate_integration_test.go`:

```go
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
```

> Note: `makeTarGz` lives in `extract_test.go` with the `unit` tag. Change its build tag line to `//go:build unit || integration` so it is shared by this integration test. (Do this as part of Step 3.)

- [ ] **Step 2: Run test to verify it fails**

First update the tag on the shared helper, then run. Run: `go test -tags integration ./pkg/selfupdate/ -v`
Expected: FAIL — `undefined: Updater` / `undefined: New` (and `Run`).

- [ ] **Step 3: Write minimal implementation**

Change the first line of `pkg/selfupdate/extract_test.go` from:

```go
//go:build unit
```

to:

```go
//go:build unit || integration
```

Create `pkg/selfupdate/selfupdate.go`:

```go
package selfupdate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/version"
)

const defaultRepo = "diagridio/dev-dashboard"

// Updater performs an in-place self-update from GitHub Releases. The base URLs,
// HTTP client, platform, current version, and target path are all injectable so
// the update flow is fully testable.
type Updater struct {
	Repo           string
	APIBase        string
	DownloadBase   string
	HTTP           *http.Client
	GOOS           string
	GOARCH         string
	CurrentVersion string
	ExecPath       string
	Out            io.Writer
}

// Result describes the outcome of an update.
type Result struct {
	From    string
	To      string
	Skipped bool // true when already on the requested/latest version
}

// New returns an Updater wired to the real GitHub endpoints and the currently
// running binary.
func New() (*Updater, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate executable: %w", err)
	}
	return &Updater{
		Repo:           defaultRepo,
		APIBase:        "https://api.github.com",
		DownloadBase:   "https://github.com",
		HTTP:           &http.Client{Timeout: 60 * time.Second},
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		CurrentVersion: version.Get().Version,
		ExecPath:       exe,
		Out:            os.Stderr,
	}, nil
}

// Run resolves, downloads, verifies, and installs the requested version (empty
// means the latest release). It is a no-op when no explicit version is given
// and the binary is already on the latest version.
func (u *Updater) Run(ctx context.Context, requested string) (Result, error) {
	var target string
	if requested == "" {
		fmt.Fprintln(u.Out, "resolving latest…")
		v, err := resolveLatest(ctx, u.HTTP, u.APIBase, u.Repo)
		if err != nil {
			return Result{}, err
		}
		target = v
		if versionsEqual(target, u.CurrentVersion) {
			fmt.Fprintf(u.Out, "already up to date (%s)\n", target)
			return Result{From: u.CurrentVersion, To: target, Skipped: true}, nil
		}
	} else {
		target = normalizeVersion(requested)
	}

	name := assetName(target, u.GOOS, u.GOARCH)
	base := fmt.Sprintf("%s/%s/releases/download/%s", u.DownloadBase, u.Repo, target)
	archiveURL := base + "/" + name
	checksumsURL := base + "/checksums.txt"

	fmt.Fprintf(u.Out, "downloading dev-dashboard %s (%s/%s)…\n", target, u.GOOS, u.GOARCH)
	archive, err := httpGet(ctx, u.HTTP, archiveURL)
	if err != nil {
		if errors.Is(err, errNotFound) {
			return Result{}, fmt.Errorf("release %s not found for %s/%s", target, u.GOOS, u.GOARCH)
		}
		return Result{}, fmt.Errorf("download %s: %w", name, err)
	}
	sums, err := httpGet(ctx, u.HTTP, checksumsURL)
	if err != nil {
		return Result{}, fmt.Errorf("download checksums: %w", err)
	}

	fmt.Fprintln(u.Out, "verifying checksum…")
	if err := verifyChecksum(archive, name, string(sums)); err != nil {
		return Result{}, err
	}

	bin, err := extractBinary(archive, u.GOOS)
	if err != nil {
		return Result{}, err
	}

	path := u.ExecPath
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	fmt.Fprintf(u.Out, "installing to %s…\n", path)
	if err := replaceExecutable(path, bin); err != nil {
		if errors.Is(err, os.ErrPermission) {
			return Result{}, fmt.Errorf("cannot write %s: permission denied — re-run the install script or use sudo: %w", path, err)
		}
		return Result{}, err
	}

	fmt.Fprintf(u.Out, "updated %s → %s (restart to use it)\n", u.CurrentVersion, target)
	return Result{From: u.CurrentVersion, To: target}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags integration ./pkg/selfupdate/ -v`
Expected: PASS (`TestRunHappyPath`, `TestRunAlreadyCurrent`, `TestRunChecksumMismatch`, `TestRunVersionNotFound`).

Also re-run the unit suite to confirm the shared-helper tag change didn't break it:
Run: `go test -tags unit ./pkg/selfupdate/ -v`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate/selfupdate.go pkg/selfupdate/selfupdate_integration_test.go pkg/selfupdate/extract_test.go
git commit -m "feat(selfupdate): Updater.Run orchestration with integration tests"
```

---

### Task 8: `update` subcommand wired into the CLI

**Files:**
- Create: `cmd/update.go`
- Modify: `cmd/root.go` (register the subcommand)
- Test: `cmd/update_test.go`

**Interfaces:**
- Consumes: `selfupdate.New`, `Updater.Run` (Task 7).
- Produces: `func newUpdateCmd() *cobra.Command`; root command gains an `update` subcommand.

- [ ] **Step 1: Write the failing test**

Create `cmd/update_test.go`:

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUpdateCmdRegistered(t *testing.T) {
	c := NewRootCmd()
	sub, _, err := c.Find([]string{"update"})
	require.NoError(t, err)
	require.Equal(t, "update", sub.Name())
}

func TestUpdateCmdArgValidation(t *testing.T) {
	c := newUpdateCmd()
	require.NoError(t, c.Args(c, []string{}))
	require.NoError(t, c.Args(c, []string{"1.2.0"}))
	require.Error(t, c.Args(c, []string{"1.2.0", "extra"}))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd/ -run 'TestUpdateCmd' -v`
Expected: FAIL — `undefined: newUpdateCmd`.

- [ ] **Step 3: Write minimal implementation**

Create `cmd/update.go`:

```go
package cmd

import (
	"github.com/diagridio/dev-dashboard/pkg/selfupdate"
	"github.com/spf13/cobra"
)

// newUpdateCmd builds the `update [version]` subcommand, which downloads and
// installs the latest release (or a specific version) over the running binary.
func newUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update [version]",
		Short: "Update dev-dashboard to the latest or a specific release",
		Long: "Download and install the latest dev-dashboard release in place, or a " +
			"specific version (e.g. `dev-dashboard update 1.2.0`). Restart any running " +
			"instance to use the new binary.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			requested := ""
			if len(args) == 1 {
				requested = args[0]
			}
			u, err := selfupdate.New()
			if err != nil {
				return err
			}
			_, err = u.Run(cmd.Context(), requested)
			return err
		},
	}
}
```

Modify `cmd/root.go`: register the subcommand. Add the line before `return c` in `NewRootCmd` (immediately after the last `c.Flags().BoolVar(...)` call):

```go
	c.AddCommand(newUpdateCmd())
	return c
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./cmd/ -run 'TestUpdateCmd' -v`
Expected: PASS (both). Also confirm the package still builds/passes: `go test -tags unit ./cmd/ -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/update.go cmd/root.go cmd/update_test.go
git commit -m "feat(cmd): add 'update' subcommand for self-update"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (add an "Updating" section)

**Interfaces:**
- Consumes: the `update` subcommand (Task 8).
- Produces: nothing (docs only).

- [ ] **Step 1: Add the "Updating" section**

In `README.md`, insert the following new section immediately **after** the `**Run:**` subsection block (the one ending with the discovery paragraph "…shows up within one refresh cycle.") and **before** the `### Mounting under a sub-path` heading:

````markdown
### Updating

Update the binary in place from GitHub Releases:

```sh
# Update to the latest release (no-op if already current)
dev-dashboard update

# Install a specific version (can downgrade or reinstall)
dev-dashboard update 1.2.0
```

`update` downloads the release archive for your platform, verifies its SHA256
against the release `checksums.txt`, and atomically replaces the running binary.
Restart any running dashboard to use the new version.

> Installs managed by a package manager (Homebrew/Scoop/winget, when available)
> should be updated through that package manager instead. If `update` reports a
> permission error, the binary lives in a location your user can't write — re-run
> the install one-liner, or move the binary somewhere writable.
````

- [ ] **Step 2: Verify the docs render**

Run: `grep -n "### Updating" README.md`
Expected: one match, located before the `### Mounting under a sub-path` line (confirm with `grep -n "Mounting under a sub-path" README.md`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the 'dev-dashboard update' command"
```

---

## Final verification

- [ ] Run the full unit suite: `go test -tags unit -race ./...` → PASS.
- [ ] Run the integration suite: `go test -tags integration -race ./...` → PASS.
- [ ] Build the binary: `go build -o bin/dev-dashboard .` → succeeds.
- [ ] Sanity-check the CLI surface: `./bin/dev-dashboard update --help` shows the `update [version]` usage.
- [ ] Confirm no new dependencies were added: `git diff main -- go.mod go.sum` → empty.

## Spec coverage check

- CLI surface (`update` / `update <version>`, stderr progress, no prompt, exit codes) → Tasks 7, 8.
- `pkg/selfupdate` package with small testable units → Tasks 1–7.
- Asset naming matching GoReleaser → Task 2.
- Checksum verification before swap → Tasks 3, 7.
- Archive extraction (tar.gz + zip) → Task 4.
- Atomic replacement incl. Windows rename-aside + restore + permission guidance → Tasks 5, 7.
- Version comparison / already-up-to-date no-op → Tasks 1, 7.
- Security (HTTPS, hardcoded repo, SHA256) → Tasks 6, 7.
- Error-handling table (404/mismatch/missing binary/not writable) → Tasks 6, 7.
- Unit + integration tests → every task; integration in Task 7.
- README "Updating" section → Task 9.
- Out of scope (signing, auto-update, `--dry-run`) → intentionally omitted.
