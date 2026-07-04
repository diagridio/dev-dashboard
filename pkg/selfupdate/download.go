package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
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

// errNotFound is returned by httpGet when the server responds 404.
var errNotFound = errors.New("not found")

// maxDownloadBytes caps how much of a response body httpGet buffers, so a
// misbehaving or malicious release server cannot exhaust memory. 200 MiB is
// far above any real release asset. var (not const) so tests can shrink it.
var maxDownloadBytes int64 = 200 << 20

// httpGet fetches url and returns the response body, mapping a 404 to
// errNotFound and any other non-200 status to an error. Bodies larger than
// maxDownloadBytes are rejected with an error (callers wrap it with download
// context, e.g. "download <asset>: …").
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
	// Read one byte past the cap so an exactly-at-cap body still succeeds and
	// an oversized one is detected without buffering it all.
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxDownloadBytes {
		return nil, fmt.Errorf("GET %s: response exceeds %d byte limit", url, maxDownloadBytes)
	}
	return body, nil
}
