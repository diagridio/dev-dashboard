package discovery

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// maxAspireAppCount bounds DEVDASHBOARD_APP_COUNT to guard against a runaway
// or hostile value forcing a huge allocation/scan loop.
const maxAspireAppCount = 1024

// ContractPresent reports whether the DEVDASHBOARD_APP_* env contract
// is set at all (anchor variable: DEVDASHBOARD_APP_COUNT). Used with mode
// unset to decide whether the contract source joins the merge.
func ContractPresent(getenv func(string) string) bool {
	return strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT")) != ""
}

// NewContractScanner parses the DEVDASHBOARD_APP_* env contract eagerly and
// returns a static Scanner over the parsed apps, each tagged with source
// (SourceAspire or SourceCompose). Malformed contracts fail
// here — at startup — with an error naming the exact variable, never at scan
// time. The returned scanner is static: env is read once; liveness comes
// from the discovery service's per-poll health/metadata probes.
func NewContractScanner(getenv func(string) string, source string) (Scanner, error) {
	countRaw := strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT"))
	count, err := strconv.Atoi(countRaw)
	if err != nil || count < 0 {
		return nil, fmt.Errorf("DEVDASHBOARD_APP_COUNT: expected a non-negative integer, got %q", countRaw)
	}
	if count > maxAspireAppCount {
		return nil, fmt.Errorf("DEVDASHBOARD_APP_COUNT: %d exceeds the maximum of %d", count, maxAspireAppCount)
	}
	defaultNS := strings.TrimSpace(getenv("DEVDASHBOARD_NAMESPACE"))
	if defaultNS == "" {
		defaultNS = "default"
	}
	results := make([]ScanResult, 0, count)
	// seenID maps a validated app id to the env var that first defined it, so a
	// later duplicate can name both variables.
	seenID := make(map[string]string, count)
	var errs []error
	for i := 0; i < count; i++ {
		idKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_ID", i)
		urlKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_DAPR_HTTP", i)
		id := strings.TrimSpace(getenv(idKey))
		raw := strings.TrimSpace(getenv(urlKey))

		bad := false
		if id == "" {
			errs = append(errs, fmt.Errorf("%s: required but empty", idKey))
			bad = true
		} else if prev, ok := seenID[id]; ok {
			errs = append(errs, fmt.Errorf("%s: duplicate app id %q (already used by %s)", idKey, id, prev))
			bad = true
		}
		u, err := url.Parse(raw)
		if raw == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("%s: expected an http(s) base URL, got %q", urlKey, raw))
			bad = true
		}
		if bad {
			continue
		}
		ns := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_NAMESPACE", i)))
		if ns == "" {
			ns = defaultNS
		}
		label := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_LABEL", i)))
		if label == "" {
			label = id
		}
		grpcKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_DAPR_GRPC", i)
		grpcAddr := strings.TrimSpace(getenv(grpcKey))
		if grpcAddr == "" {
			grpcAddr = deriveGRPCAddr(u)
		} else if err := validateHostPort(grpcAddr); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", grpcKey, err))
			continue
		}
		seenID[id] = idKey
		results = append(results, ScanResult{
			AppID:            id,
			DaprHTTPBaseURL:  strings.TrimRight(raw, "/"),
			DaprGRPCAddr:     grpcAddr,
			Namespace:        ns,
			Label:            label,
			Source:           source,
			SidecarReachable: true,
		})
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return func() ([]ScanResult, error) {
		out := make([]ScanResult, len(results))
		copy(out, results)
		return out, nil
	}, nil
}

// defaultDaprGRPCPort is daprd's default gRPC port, used when the contract
// declares only an HTTP base URL.
const defaultDaprGRPCPort = "50001"

// deriveGRPCAddr builds the sidecar gRPC endpoint from the validated HTTP
// base URL: the same host, with daprd's default gRPC port. Correct in every
// compose network shape because it inherits whichever host already reaches
// the sidecar.
func deriveGRPCAddr(u *url.URL) string {
	return net.JoinHostPort(u.Hostname(), defaultDaprGRPCPort)
}

// validateHostPort rejects anything that is not a bare host:port with a
// numeric in-range port (a URL, a bare host, an empty host).
func validateHostPort(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("expected a host:port address, got %q", addr)
	}
	if host == "" {
		return fmt.Errorf("expected a host:port address with a non-empty host, got %q", addr)
	}
	if strings.Contains(host, "/") {
		return fmt.Errorf("expected a host:port address, not a URL, got %q", addr)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("expected a port number in 1-65535, got %q", addr)
	}
	return nil
}
