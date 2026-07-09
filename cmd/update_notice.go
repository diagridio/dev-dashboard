package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/briandowns/spinner"
	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/mattn/go-isatty"
)

// formatUpdateNotice renders the two-line "new version available" notice,
// followed by a blank line separating it from the startup message. The GitHub
// release URL is appended to the version line when known.
func formatUpdateNotice(current, latest, releaseURL string) string {
	link := ""
	if releaseURL != "" {
		link = fmt.Sprintf(" (%s)", releaseURL)
	}
	return fmt.Sprintf(
		"A new version of the Dapr Dev Dashboard is available: %s → %s%s\n"+
			"Run `dev-dashboard update` to upgrade.\n\n",
		current, latest, link)
}

// printUpdateNotice writes the notice to w when an update is available; it writes
// nothing otherwise.
func printUpdateNotice(w io.Writer, r updatecheck.Result) {
	if !r.UpdateAvailable {
		return
	}
	fmt.Fprint(w, formatUpdateNotice(r.Current, r.Latest, r.ReleaseURL))
}

// maybeAnnounceUpdate runs the startup version check and prints the notice to
// stdout as the first output. For dev/source builds it does nothing (no spinner,
// no network call). On a TTY it shows a spinner while the (2s-bounded) check runs.
func maybeAnnounceUpdate(ctx context.Context, uc updatecheck.Service, current string) {
	if uc == nil || !updatecheck.IsReleaseVersion(current) {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var sp *spinner.Spinner
	if isatty.IsTerminal(os.Stdout.Fd()) {
		sp = spinner.New(spinner.CharSets[14], 100*time.Millisecond, spinner.WithWriter(os.Stdout))
		sp.Suffix = " Checking for new versions…"
		sp.Start()
	}
	r := uc.Check(cctx)
	if sp != nil {
		sp.Stop()
	}
	printUpdateNotice(os.Stdout, r)
}
