package discovery

import "errors"

// Merge combines scanners into one. A failing scanner is logged and skipped so
// one source (e.g. docker being absent) never hides the others; the merged
// scan errors only when every scanner fails. When any result has
// Source == SourceAspire, it wins key collisions: every other result sharing
// its Key() is dropped (an Aspire-launched daprd host process is otherwise
// double-counted by both the standalone scan and the env contract). Order is
// stable otherwise.
func Merge(scanners ...Scanner) Scanner {
	return func() ([]ScanResult, error) {
		var out []ScanResult
		var errs []error
		for _, scan := range scanners {
			res, err := scan()
			if err != nil {
				errs = append(errs, err)
				continue
			}
			out = append(out, res...)
		}
		if len(scanners) > 0 && len(errs) == len(scanners) {
			return nil, errors.Join(errs...)
		}
		for _, err := range errs {
			logger().Warn("app scan source failed", "err", err)
		}
		return dedupAspireWins(out), nil
	}
}

// dedupAspireWins drops non-aspire results whose Key() collides with an
// aspire result's Key(), keeping the aspire entry (it carries
// DaprHTTPBaseURL). Order is preserved otherwise.
func dedupAspireWins(results []ScanResult) []ScanResult {
	aspireKeys := make(map[string]bool)
	for _, r := range results {
		if r.Source == SourceAspire {
			aspireKeys[r.Key()] = true
		}
	}
	if len(aspireKeys) == 0 {
		return results
	}
	out := make([]ScanResult, 0, len(results))
	for _, r := range results {
		if r.Source != SourceAspire && aspireKeys[r.Key()] {
			continue
		}
		out = append(out, r)
	}
	return out
}
