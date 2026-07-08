//go:build unit

package cmd

import (
	"bytes"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/stretchr/testify/require"
)

func TestFormatUpdateNotice(t *testing.T) {
	got := formatUpdateNotice("v1.2.0", "v1.3.0")
	require.Equal(t,
		"A new version of the Dapr Dev Dashboard is available: v1.2.0 → v1.3.0\n"+
			"Run `dev-dashboard update` to upgrade.\n",
		got)
}

func TestPrintUpdateNoticeWhenAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true})
	require.Contains(t, buf.String(), "v1.2.0 → v1.3.0")
	require.Contains(t, buf.String(), "dev-dashboard update")
}

func TestPrintUpdateNoticeSuppressedWhenNotAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{Current: "v1.3.0", Latest: "v1.3.0", UpdateAvailable: false})
	require.Empty(t, buf.String())
}
