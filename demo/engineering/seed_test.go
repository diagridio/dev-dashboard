package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

type fakeWC struct {
	mu           sync.Mutex
	existing     map[string]bool
	scheduled    []string
	calls        []string
	termErr      error
	termFailures int           // first N Terminate calls fail with "boom"
	gate         chan struct{} // if set, Terminate blocks until closed
}

func (f *fakeWC) callLog() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeWC) count(prefix string) int {
	n := 0
	for _, c := range f.callLog() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (f *fakeWC) Exists(_ context.Context, id string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.existing[id], nil
}
func (f *fakeWC) Schedule(_ context.Context, name, id string, _ any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scheduled = append(f.scheduled, id)
	f.calls = append(f.calls, "schedule:"+id)
	return nil
}
func (f *fakeWC) Terminate(_ context.Context, id string) error {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "terminate:"+id)
	if f.termFailures > 0 {
		f.termFailures--
		return errors.New("boom")
	}
	return f.termErr
}
func (f *fakeWC) PurgeRecursive(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "purge:"+id)
	return nil
}

type fakePS struct{ keys []string }

func (f *fakePS) Put(_ context.Context, key string, _ []byte) error {
	f.keys = append(f.keys, key)
	return nil
}

func TestSeedSchedulesMissingOnly(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{"sweep-001": true}}
	if err := Seed(context.Background(), wc, &fakePS{}); err != nil {
		t.Fatal(err)
	}
	if len(wc.scheduled) != 5 {
		t.Fatalf("want 5 schedules, got %v", wc.scheduled)
	}
	for _, id := range wc.scheduled {
		if id == "sweep-001" {
			t.Fatal("existing sweep rescheduled")
		}
	}
}

func TestSeedAlwaysReuploadsPayload(t *testing.T) {
	existing := map[string]bool{}
	for _, s := range Scenario() {
		existing[s.ID] = true
	}
	wc, ps := &fakeWC{existing: existing}, &fakePS{}
	if err := Seed(context.Background(), wc, ps); err != nil {
		t.Fatal(err)
	}
	if len(wc.scheduled) != 0 {
		t.Fatalf("unexpected schedules %v", wc.scheduled)
	}
	want := "workflow-payloads/sweep-006/" + PayloadSHA()
	if len(ps.keys) != 1 || ps.keys[0] != want {
		t.Fatalf("want one Put with %q, got %v", want, ps.keys)
	}
	if n := len(TelemetryPayload()); n < 7000 || n > 9500 {
		t.Fatalf("payload should be ~8KB, got %d", n)
	}
}

func TestPayloadDeterministic(t *testing.T) {
	if PayloadSHA() != PayloadSHA() || string(TelemetryPayload()) != string(TelemetryPayload()) {
		t.Fatal("payload not deterministic")
	}
}

func TestResetTerminatesThenPurges(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{}, termErr: errors.New("workflow is not running")}
	if err := Reset(context.Background(), wc, &fakePS{}); err != nil {
		t.Fatal(err)
	}
	idx := map[string]int{}
	for i, c := range wc.calls {
		idx[c] = i
	}
	for _, s := range Scenario() {
		ti, ok1 := idx["terminate:"+s.ID]
		pi, ok2 := idx["purge:"+s.ID]
		if !ok1 || !ok2 || ti > pi {
			t.Errorf("%s: terminate must precede purge (%v)", s.ID, wc.calls)
		}
		if si, ok := idx["schedule:"+s.ID]; !ok || si < pi {
			t.Errorf("%s: schedule must follow purge", s.ID)
		}
	}
}

func TestResetFailsOnOtherTerminateError(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{}, termErr: errors.New("boom")}
	err := Reset(context.Background(), wc, &fakePS{})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("want boom error, got %v", err)
	}
}
