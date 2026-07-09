package cmd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/briandowns/spinner"
	"github.com/diagridio/dev-dashboard/pkg/selfupdate"
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

// maybeAnnounceUpdate runs the startup version check, prints the notice to
// stdout as the first output, and returns the check result so the caller can
// offer an interactive update. For dev/source builds it does nothing (no
// spinner, no network call). On a TTY it shows a spinner while the (2s-bounded)
// check runs.
func maybeAnnounceUpdate(ctx context.Context, uc updatecheck.Service, current string) updatecheck.Result {
	if uc == nil || !updatecheck.IsReleaseVersion(current) {
		return updatecheck.Result{Current: current}
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
	return r
}

// promptUpdateNow asks the Y/n question and reads one line of input. Enter,
// "y", and "yes" (any case) accept; anything else — including EOF — declines.
func promptUpdateNow(in io.Reader, out io.Writer) bool {
	fmt.Fprint(out, "Do you want to update now? (Y/n) ")
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "", "y", "yes":
		return true
	default:
		return false
	}
}

// maybeOfferUpdate prompts to install an available update. It does nothing
// unless an update is available and the session is interactive. On acceptance
// it runs install (which on success restarts the process and never returns);
// an install failure is reported and startup continues on the current version.
func maybeOfferUpdate(ctx context.Context, r updatecheck.Result, in io.Reader, out io.Writer, interactive bool, install func(context.Context, string) error) {
	if !r.UpdateAvailable || !interactive {
		return
	}
	if !promptUpdateNow(in, out) {
		fmt.Fprintln(out)
		return
	}
	if err := install(ctx, r.Latest); err != nil {
		fmt.Fprintf(out, "update failed: %v — continuing with the current version\n\n", err)
	}
}

// selfUpdateAndRestart installs the given release over the running binary and
// re-executes the process with the same arguments, so the new version starts
// in place of the old one. It only returns on failure.
func selfUpdateAndRestart(ctx context.Context, target string) error {
	u, err := selfupdate.New()
	if err != nil {
		return err
	}
	if _, err := u.Run(ctx, target); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable for restart: %w", err)
	}
	fmt.Println("restarting…")
	return restartSelf(exe, os.Args)
}
