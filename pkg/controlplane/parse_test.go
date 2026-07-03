//go:build unit

package controlplane

import (
	"os"
	"testing"
)

func TestParseInspectRunning(t *testing.T) {
	data, err := os.ReadFile("testdata/inspect_running.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseInspect(data)
	if err != nil {
		t.Fatalf("parseInspect: %v", err)
	}
	if got.State != StatusRunning {
		t.Errorf("State = %q, want running", got.State)
	}
	if !got.Healthy {
		t.Error("Healthy = false, want true")
	}
	if len(got.Ports) != 1 || got.Ports[0] != "50006/tcp" {
		t.Errorf("Ports = %v, want [50006/tcp]", got.Ports)
	}
	if got.LogPath == "" {
		t.Error("LogPath empty, want a path")
	}
}

func TestParseMemUsage(t *testing.T) {
	cases := map[string]uint64{
		"12.34MiB / 7.667GiB": 12939428, // 12.34 * 1024 * 1024
		"8.5MiB / 7.667GiB":   8912896,  // 8.5 * 1024 * 1024
		"1.5GiB / 7.667GiB":   1610612736,
		"512KiB / 7.667GiB":   524288,
		"0B / 7.667GiB":       0,
		"garbage":             0,
	}
	for in, want := range cases {
		if got := parseMemUsage(in); got != want {
			t.Errorf("parseMemUsage(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseStats(t *testing.T) {
	data, err := os.ReadFile("testdata/stats.json")
	if err != nil {
		t.Fatal(err)
	}
	got := parseStats(data)
	s, ok := got["dapr_scheduler"]
	if !ok {
		t.Fatal("dapr_scheduler missing from stats")
	}
	if s.Human != "12.34MiB" {
		t.Errorf("Human = %q, want 12.34MiB", s.Human)
	}
	if s.Bytes == 0 {
		t.Error("Bytes = 0, want > 0")
	}
}
