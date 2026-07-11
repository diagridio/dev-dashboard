//go:build unit

package discovery

import (
	"strings"
	"testing"
)

func envFunc(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

func TestAspireContractPresent(t *testing.T) {
	if AspireContractPresent(envFunc(nil)) {
		t.Fatal("empty env: want false")
	}
	if !AspireContractPresent(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"})) {
		t.Fatal("count set: want true")
	}
}

func TestNewAspireScannerHappyPath(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "2",
		"DEVDASHBOARD_APP_0_ID":        "orders",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://orders-dapr:3500/",
		"DEVDASHBOARD_APP_1_ID":        "payments",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "http://payments-dapr:3501",
		"DEVDASHBOARD_APP_1_NAMESPACE": "prod",
		"DEVDASHBOARD_APP_1_LABEL":     "Payments API",
	}))
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

func TestNewAspireScannerNamespaceDefault(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{
		"DEVDASHBOARD_NAMESPACE":       "team-a",
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "a",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, _ := scan()
	if got[0].Namespace != "team-a" {
		t.Fatalf("namespace: got %q want team-a", got[0].Namespace)
	}
}

func TestNewAspireScannerCountZero(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := scan()
	if err != nil || len(got) != 0 {
		t.Fatalf("want empty scan, got %v / %v", got, err)
	}
}

func TestNewAspireScannerErrorsNameTheVariable(t *testing.T) {
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
			_, err := NewAspireScanner(envFunc(tc.env))
			if err == nil {
				t.Fatal("want error")
			}
			if !strings.Contains(err.Error(), tc.wantVar) {
				t.Fatalf("error %q does not name %s", err, tc.wantVar)
			}
		})
	}
}
