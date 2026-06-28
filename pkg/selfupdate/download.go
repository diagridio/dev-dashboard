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
