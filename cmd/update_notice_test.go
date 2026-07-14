//go:build unit

package cmd

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/stretchr/testify/require"
)

func TestFormatUpdateNotice(t *testing.T) {
	got := formatUpdateNotice("v1.2.0", "v1.3.0", "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0")
	// The trailing blank line separates the notice from the startup message.
	require.Equal(t,
		"A new version of the Dapr Dev Dashboard is available: v1.2.0 → v1.3.0 (https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0)\n"+
			"Run `diagrid-dev-dashboard update` to upgrade.\n\n",
		got)
}

func TestFormatUpdateNoticeWithoutReleaseURL(t *testing.T) {
	got := formatUpdateNotice("v1.2.0", "v1.3.0", "")
	require.Equal(t,
		"A new version of the Dapr Dev Dashboard is available: v1.2.0 → v1.3.0\n"+
			"Run `diagrid-dev-dashboard update` to upgrade.\n\n",
		got)
}

func TestPrintUpdateNoticeWhenAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{
		Current:         "v1.2.0",
		Latest:          "v1.3.0",
		UpdateAvailable: true,
		ReleaseURL:      "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0",
	})
	require.Contains(t, buf.String(), "v1.2.0 → v1.3.0 (https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0)")
	require.Contains(t, buf.String(), "diagrid-dev-dashboard update")
}

func TestPrintUpdateNoticeSuppressedWhenNotAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{Current: "v1.3.0", Latest: "v1.3.0", UpdateAvailable: false})
	require.Empty(t, buf.String())
}

func TestPromptUpdateNow(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		{"enter accepts", "\n", true},
		{"y accepts", "y\n", true},
		{"uppercase Y accepts", "Y\n", true},
		{"yes accepts", "yes\n", true},
		{"n declines", "n\n", false},
		{"uppercase N declines", "N\n", false},
		{"anything else declines", "maybe\n", false},
		{"EOF declines", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			got := promptUpdateNow(strings.NewReader(tc.input), &out)
			require.Equal(t, tc.want, got)
			require.Contains(t, out.String(), "Do you want to update now? (Y/n)")
		})
	}
}

func TestMaybeOfferUpdateInstallsOnAccept(t *testing.T) {
	installed := ""
	install := func(_ context.Context, target string) error { installed = target; return nil }
	var out bytes.Buffer
	maybeOfferUpdate(context.Background(),
		updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true},
		strings.NewReader("y\n"), &out, true, install)
	require.Equal(t, "v1.3.0", installed)
}

func TestMaybeOfferUpdateSkipsOnDecline(t *testing.T) {
	called := false
	install := func(context.Context, string) error { called = true; return nil }
	var out bytes.Buffer
	maybeOfferUpdate(context.Background(),
		updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true},
		strings.NewReader("n\n"), &out, true, install)
	require.False(t, called)
	require.Contains(t, out.String(), "Do you want to update now? (Y/n)")
}

func TestMaybeOfferUpdateSkipsWhenNotInteractive(t *testing.T) {
	called := false
	install := func(context.Context, string) error { called = true; return nil }
	var out bytes.Buffer
	maybeOfferUpdate(context.Background(),
		updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true},
		strings.NewReader("y\n"), &out, false, install)
	require.False(t, called)
	require.Empty(t, out.String())
}

func TestMaybeOfferUpdateSkipsWhenNoUpdate(t *testing.T) {
	called := false
	install := func(context.Context, string) error { called = true; return nil }
	var out bytes.Buffer
	maybeOfferUpdate(context.Background(),
		updatecheck.Result{Current: "v1.3.0", Latest: "v1.3.0", UpdateAvailable: false},
		strings.NewReader("y\n"), &out, true, install)
	require.False(t, called)
	require.Empty(t, out.String())
}

func TestMaybeOfferUpdateContinuesOnInstallError(t *testing.T) {
	install := func(context.Context, string) error { return errors.New("network down") }
	var out bytes.Buffer
	maybeOfferUpdate(context.Background(),
		updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true},
		strings.NewReader("\n"), &out, true, install)
	require.Contains(t, out.String(), "update failed")
	require.Contains(t, out.String(), "network down")
	require.Contains(t, out.String(), "continuing with the current version")
}
