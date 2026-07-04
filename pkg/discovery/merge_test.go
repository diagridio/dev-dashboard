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
