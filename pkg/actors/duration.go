package actors

import (
	"strings"
	"time"
)

// compactDuration rewrites a Go-parsable duration such as "0h30m0s0ms" as
// "30m", dropping zero units. Anything time.ParseDuration rejects (cron,
// "@every ...", ISO 8601) is returned unchanged.
func compactDuration(s string) string {
	d, err := time.ParseDuration(s)
	if err != nil {
		return s
	}
	out := d.String()
	if strings.HasSuffix(out, "m0s") {
		out = strings.TrimSuffix(out, "0s")
	}
	if strings.HasSuffix(out, "h0m") {
		out = strings.TrimSuffix(out, "0m")
	}
	return out
}
