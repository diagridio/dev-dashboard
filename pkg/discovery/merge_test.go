//go:build unit

package discovery

import (
	"errors"
	"testing"
)

func TestMergeConcatenates(t *testing.T) {
	a := func() ([]ScanResult, error) { return []ScanResult{{AppID: "a"}}, nil }
	b := func() ([]ScanResult, error) { return []ScanResult{{AppID: "b"}, {AppID: "c"}}, nil }
	got, err := Merge(a, b)()
	if err != nil || len(got) != 3 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestMergeToleratesPartialFailure(t *testing.T) {
	ok := func() ([]ScanResult, error) { return []ScanResult{{AppID: "a"}}, nil }
	bad := func() ([]ScanResult, error) { return nil, errors.New("docker down") }
	got, err := Merge(ok, bad)()
	if err != nil {
		t.Fatalf("one healthy scanner must win: %v", err)
	}
	if len(got) != 1 || got[0].AppID != "a" {
		t.Fatalf("got %v", got)
	}
}

func TestMergeAllFail(t *testing.T) {
	bad := func() ([]ScanResult, error) { return nil, errors.New("boom") }
	if _, err := Merge(bad, bad)(); err == nil {
		t.Fatal("all scanners failing must return an error")
	}
}

func TestMergeAspireWinsKeyCollision(t *testing.T) {
	cases := []struct {
		name    string
		aspire  []ScanResult
		other   []ScanResult
		wantLen int
		check   func(t *testing.T, got []ScanResult)
	}{
		{
			name:    "aspire and standalone same AppID collapse to one, aspire wins",
			aspire:  []ScanResult{{AppID: "orders", Source: SourceAspire, DaprHTTPBaseURL: "http://orders-dapr:3500"}},
			other:   []ScanResult{{AppID: "orders", Source: SourceStandalone}},
			wantLen: 1,
			check: func(t *testing.T, got []ScanResult) {
				if got[0].Source != SourceAspire || got[0].DaprHTTPBaseURL == "" {
					t.Fatalf("expected surviving result to be the aspire entry, got %+v", got[0])
				}
			},
		},
		{
			name:    "aspire and compose with different keys are both kept",
			aspire:  []ScanResult{{AppID: "orders", Source: SourceAspire}},
			other:   []ScanResult{{AppID: "checkout", Source: SourceCompose, AppContainerName: "checkout-1"}},
			wantLen: 2,
		},
		{
			name:    "no aspire results leaves output unchanged",
			aspire:  nil,
			other:   []ScanResult{{AppID: "a", Source: SourceStandalone}, {AppID: "b", Source: SourceCompose, AppContainerName: "b-1"}},
			wantLen: 2,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			aspireScan := func() ([]ScanResult, error) { return tc.aspire, nil }
			otherScan := func() ([]ScanResult, error) { return tc.other, nil }
			got, err := Merge(otherScan, aspireScan)()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != tc.wantLen {
				t.Fatalf("got %d results, want %d: %+v", len(got), tc.wantLen, got)
			}
			if tc.check != nil {
				tc.check(t, got)
			}
		})
	}
}
