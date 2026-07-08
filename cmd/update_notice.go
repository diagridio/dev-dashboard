package cmd

import (
	"fmt"
	"io"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
)

// formatUpdateNotice renders the two-line "new version available" notice.
func formatUpdateNotice(current, latest string) string {
	return fmt.Sprintf(
		"A new version of the Dapr Dev Dashboard is available: %s → %s\n"+
			"Run `dev-dashboard update` to upgrade.\n",
		current, latest)
}

// printUpdateNotice writes the notice to w when an update is available; it writes
// nothing otherwise.
func printUpdateNotice(w io.Writer, r updatecheck.Result) {
	if !r.UpdateAvailable {
		return
	}
	fmt.Fprint(w, formatUpdateNotice(r.Current, r.Latest))
}
