package discovery

import "errors"

// Merge combines scanners into one. A failing scanner is logged and skipped so
// one source (e.g. docker being absent) never hides the others; the merged
// scan errors only when every scanner fails.
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
		return out, nil
	}
}
