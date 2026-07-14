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
	name := "diagrid-dev-dashboard_1.2.0_linux_amd64.tar.gz"
	checksums := "deadbeef  other-file.zip\n" + hexSum + "  " + name + "\n"

	require.NoError(t, verifyChecksum(archive, name, checksums))

	// Wrong hash for our file.
	bad := "0000  " + name + "\n"
	require.Error(t, verifyChecksum(archive, name, bad))

	// No entry for our file.
	require.Error(t, verifyChecksum(archive, name, "deadbeef  other-file.zip\n"))
}
