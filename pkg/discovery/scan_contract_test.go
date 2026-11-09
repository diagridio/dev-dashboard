//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func envFunc(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

func TestContractPresent(t *testing.T) {
	if ContractPresent(envFunc(nil)) {
		t.Fatal("empty env: want false")
	}
	if !ContractPresent(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"})) {
		t.Fatal("count set: want true")
	}
}

func TestNewContractScannerHappyPath(t *testing.T) {
	scan, err := NewContractScanner(envFunc(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "2",
		"DEVDASHBOARD_APP_0_ID":        "orders",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://orders-dapr:3500/",
		"DEVDASHBOARD_APP_1_ID":        "payments",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "http://payments-dapr:3501",
		"DEVDASHBOARD_APP_1_NAMESPACE": "prod",
		"DEVDASHBOARD_APP_1_LABEL":     "Payments API",
	}), SourceAspire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := scan()
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d results, want 2", len(got))
	}
	r0, r1 := got[0], got[1]
	if r0.AppID != "orders" || r0.DaprHTTPBaseURL != "http://orders-dapr:3500" {
		t.Fatalf("r0: %+v (trailing slash must be trimmed)", r0)
	}
	if r0.Namespace != "default" || r0.Label != "orders" {
		t.Fatalf("r0 defaults: ns=%q label=%q", r0.Namespace, r0.Label)
	}
	if r0.Source != SourceAspire || !r0.SidecarReachable {
		t.Fatalf("r0 source/reachable: %+v", r0)
	}
	if r1.Namespace != "prod" || r1.Label != "Payments API" {
		t.Fatalf("r1 overrides: ns=%q label=%q", r1.Namespace, r1.Label)
	}
}

func TestNewContractScannerNamespaceDefault(t *testing.T) {
	scan, err := NewContractScanner(envFunc(map[string]string{
		"DEVDASHBOARD_NAMESPACE":       "team-a",
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "a",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
	}), SourceAspire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, _ := scan()
	if got[0].Namespace != "team-a" {
		t.Fatalf("namespace: got %q want team-a", got[0].Namespace)
	}
}

func TestNewContractScannerCountZero(t *testing.T) {
	scan, err := NewContractScanner(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"}), SourceAspire)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := scan()
	if err != nil || len(got) != 0 {
		t.Fatalf("want empty scan, got %v / %v", got, err)
	}
}

func TestNewContractScannerErrorsNameTheVariable(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantVar string
	}{
		{"missing count", map[string]string{}, "DEVDASHBOARD_APP_COUNT"},
		{"non-numeric count", map[string]string{"DEVDASHBOARD_APP_COUNT": "two"}, "DEVDASHBOARD_APP_COUNT"},
		{"negative count", map[string]string{"DEVDASHBOARD_APP_COUNT": "-1"}, "DEVDASHBOARD_APP_COUNT"},
		{"missing id", map[string]string{
			"DEVDASHBOARD_APP_COUNT":       "1",
			"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
		}, "DEVDASHBOARD_APP_0_ID"},
		{"missing url", map[string]string{
			"DEVDASHBOARD_APP_COUNT": "1",
			"DEVDASHBOARD_APP_0_ID":  "a",
		}, "DEVDASHBOARD_APP_0_DAPR_HTTP"},
		{"bad url scheme", map[string]string{
			"DEVDASHBOARD_APP_COUNT":       "1",
			"DEVDASHBOARD_APP_0_ID":        "a",
			"DEVDASHBOARD_APP_0_DAPR_HTTP": "ftp://a:3500",
		}, "DEVDASHBOARD_APP_0_DAPR_HTTP"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewContractScanner(envFunc(tc.env), SourceAspire)
			if err == nil {
				t.Fatal("want error")
			}
			if !strings.Contains(err.Error(), tc.wantVar) {
				t.Fatalf("error %q does not name %s", err, tc.wantVar)
			}
		})
	}
}

func TestNewContractScannerCountCap(t *testing.T) {
	_, err := NewContractScanner(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "1025"}), SourceAspire)
	if err == nil {
		t.Fatal("want error for count over cap")
	}
	if !strings.Contains(err.Error(), "DEVDASHBOARD_APP_COUNT") || !strings.Contains(err.Error(), "1024") {
		t.Fatalf("error %q must name the variable and the cap 1024", err)
	}
}

func TestNewContractScannerDuplicateID(t *testing.T) {
	_, err := NewContractScanner(envFunc(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "3",
		"DEVDASHBOARD_APP_0_ID":        "orders",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
		"DEVDASHBOARD_APP_1_ID":        "payments",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "http://b:3500",
		"DEVDASHBOARD_APP_2_ID":        "orders",
		"DEVDASHBOARD_APP_2_DAPR_HTTP": "http://c:3500",
	}), SourceAspire)
	if err == nil {
		t.Fatal("want error for duplicate app id")
	}
	msg := err.Error()
	if !strings.Contains(msg, "DEVDASHBOARD_APP_2_ID") || !strings.Contains(msg, "DEVDASHBOARD_APP_0_ID") {
		t.Fatalf("error %q must name both DEVDASHBOARD_APP_2_ID and DEVDASHBOARD_APP_0_ID", err)
	}
	if !strings.Contains(msg, "orders") {
		t.Fatalf("error %q must name the duplicate id", err)
	}
}

func TestNewContractScannerReportsAllErrors(t *testing.T) {
	// Index 0: missing ID (valid URL). Index 1: valid ID, bad URL. Both
	// variables must appear in the joined error.
	_, err := NewContractScanner(envFunc(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "2",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
		"DEVDASHBOARD_APP_1_ID":        "b",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "ftp://b:3500",
	}), SourceAspire)
	if err == nil {
		t.Fatal("want error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "DEVDASHBOARD_APP_0_ID") || !strings.Contains(msg, "DEVDASHBOARD_APP_1_DAPR_HTTP") {
		t.Fatalf("error %q must report both index-0 ID and index-1 URL variables", err)
	}
}

// envMap returns a getenv func over a fixed map.
func envMap(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

// baseContract is a single valid app, for tests that vary one thing.
func baseContract() map[string]string {
	return map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order-processor",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://order-dapr:3500",
	}
}

func TestContractScannerSourceParameter(t *testing.T) {
	for _, source := range []string{SourceAspire, SourceCompose} {
		t.Run(source, func(t *testing.T) {
			scan, err := NewContractScanner(envMap(baseContract()), source)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got, err := scan()
			if err != nil {
				t.Fatalf("unexpected scan error: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("got %d results, want 1", len(got))
			}
			if got[0].Source != source {
				t.Fatalf("got source %q want %q", got[0].Source, source)
			}
		})
	}
}

func TestContractScannerDerivesGRPCAddr(t *testing.T) {
	tests := []struct {
		name     string
		daprHTTP string
		want     string
	}{
		// The three compose network shapes from the design doc.
		{name: "separate sidecar service", daprHTTP: "http://order-dapr:3500", want: "order-dapr:50001"},
		{name: "app joins sidecar namespace", daprHTTP: "http://daprd:3500", want: "daprd:50001"},
		{name: "sidecar joins app namespace", daprHTTP: "http://order-processor:3500", want: "order-processor:50001"},
		// No explicit port in the URL.
		{name: "host without port", daprHTTP: "http://order-dapr", want: "order-dapr:50001"},
		// Host posture / Aspire values still derive sanely.
		{name: "loopback with port", daprHTTP: "http://127.0.0.1:3500", want: "127.0.0.1:50001"},
		{name: "https base url", daprHTTP: "https://order-dapr:3500", want: "order-dapr:50001"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := baseContract()
			env["DEVDASHBOARD_APP_0_DAPR_HTTP"] = tc.daprHTTP
			scan, err := NewContractScanner(envMap(env), SourceCompose)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got, _ := scan()
			if got[0].DaprGRPCAddr != tc.want {
				t.Fatalf("got %q want %q", got[0].DaprGRPCAddr, tc.want)
			}
		})
	}
}

func TestContractScannerExplicitGRPCAddrWins(t *testing.T) {
	env := baseContract()
	env["DEVDASHBOARD_APP_0_DAPR_GRPC"] = "sidecar-alias:60001"
	scan, err := NewContractScanner(envMap(env), SourceCompose)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, _ := scan()
	if got[0].DaprGRPCAddr != "sidecar-alias:60001" {
		t.Fatalf("got %q want %q", got[0].DaprGRPCAddr, "sidecar-alias:60001")
	}
}

func TestContractScannerRejectsMalformedGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		val  string
	}{
		{name: "no port", val: "order-dapr"},
		{name: "non-numeric port", val: "order-dapr:grpc"},
		{name: "port out of range", val: "order-dapr:70000"},
		{name: "url not host:port", val: "http://order-dapr:50001"},
		{name: "empty host", val: ":50001"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := baseContract()
			env["DEVDASHBOARD_APP_0_DAPR_GRPC"] = tc.val
			_, err := NewContractScanner(envMap(env), SourceCompose)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			// Fail-fast errors must name the exact variable.
			if !strings.Contains(err.Error(), "DEVDASHBOARD_APP_0_DAPR_GRPC") {
				t.Fatalf("error must name the variable, got: %v", err)
			}
		})
	}
}

func contractInstanceFor(t *testing.T, source, daprURL string) Instance {
	t.Helper()
	scan, err := NewContractScanner(envMap(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": daprURL,
	}), source)
	if err != nil {
		t.Fatal(err)
	}
	svc := New(scan, &http.Client{Timeout: 500 * time.Millisecond})
	list, err := svc.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d instances, want 1", len(list))
	}
	return list[0]
}

func TestContractSidecarReachability(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/healthz") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.17.0"}`))
	}))
	defer up.Close()
	down := httptest.NewServer(http.NotFoundHandler())
	downURL := down.URL
	down.Close()

	tests := []struct {
		name   string
		source string
		url    string
		want   bool
	}{
		{"compose reachable", SourceCompose, up.URL, true},
		{"compose unreachable", SourceCompose, downURL, false},
		{"aspire reachable", SourceAspire, up.URL, true},
		{"aspire unreachable stays true", SourceAspire, downURL, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in := contractInstanceFor(t, tc.source, tc.url)
			if in.Source != tc.source {
				t.Fatalf("source = %q want %q", in.Source, tc.source)
			}
			if in.SidecarReachable != tc.want {
				t.Fatalf("SidecarReachable = %v want %v", in.SidecarReachable, tc.want)
			}
			if in.DaprdStatus == StatusStopped {
				t.Fatalf("DaprdStatus must not be stopped")
			}
		})
	}
}
