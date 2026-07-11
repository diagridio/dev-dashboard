package discovery

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// AspireContractPresent reports whether the DEVDASHBOARD_APP_* env contract
// is set at all (anchor variable: DEVDASHBOARD_APP_COUNT). Used with mode
// unset to decide whether the aspire source joins the merge.
func AspireContractPresent(getenv func(string) string) bool {
	return strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT")) != ""
}

// NewAspireScanner parses the DEVDASHBOARD_APP_* env contract eagerly and
// returns a static Scanner over the parsed apps. Malformed contracts fail
// here — at startup — with an error naming the exact variable, never at scan
// time. The returned scanner is static: env is read once; liveness comes
// from the discovery service's per-poll health/metadata probes.
func NewAspireScanner(getenv func(string) string) (Scanner, error) {
	countRaw := strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT"))
	count, err := strconv.Atoi(countRaw)
	if err != nil || count < 0 {
		return nil, fmt.Errorf("DEVDASHBOARD_APP_COUNT: expected a non-negative integer, got %q", countRaw)
	}
	defaultNS := strings.TrimSpace(getenv("DEVDASHBOARD_NAMESPACE"))
	if defaultNS == "" {
		defaultNS = "default"
	}
	results := make([]ScanResult, 0, count)
	for i := 0; i < count; i++ {
		idKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_ID", i)
		urlKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_DAPR_HTTP", i)
		id := strings.TrimSpace(getenv(idKey))
		if id == "" {
			return nil, fmt.Errorf("%s: required but empty", idKey)
		}
		raw := strings.TrimSpace(getenv(urlKey))
		u, err := url.Parse(raw)
		if raw == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("%s: expected an http(s) base URL, got %q", urlKey, raw)
		}
		ns := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_NAMESPACE", i)))
		if ns == "" {
			ns = defaultNS
		}
		label := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_LABEL", i)))
		if label == "" {
			label = id
		}
		results = append(results, ScanResult{
			AppID:            id,
			DaprHTTPBaseURL:  strings.TrimRight(raw, "/"),
			Namespace:        ns,
			Label:            label,
			Source:           SourceAspire,
			SidecarReachable: true,
		})
	}
	return func() ([]ScanResult, error) {
		out := make([]ScanResult, len(results))
		copy(out, results)
		return out, nil
	}, nil
}
