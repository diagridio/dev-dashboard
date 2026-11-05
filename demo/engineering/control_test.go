package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func status(t *testing.T, h http.Handler) string {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/demo/status", nil))
	if rr.Code != 200 {
		t.Fatalf("status code %d", rr.Code)
	}
	return strings.TrimSpace(rr.Body.String())
}

func TestControlStatusAndReset(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{}}
	c := NewController(wc, &fakePS{}, nil)
	h := c.Handler()
	if got := status(t, h); got != `{"seeded":false}` {
		t.Fatalf("before seed: %s", got)
	}
	if err := c.SeedOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := status(t, h); got != `{"seeded":true}` {
		t.Fatalf("after seed: %s", got)
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/demo/reset", nil))
	if rr.Code != http.StatusAccepted {
		t.Fatalf("reset code %d", rr.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for status(t, h) != `{"seeded":true}` {
		if time.Now().After(deadline) {
			t.Fatal("never reseeded")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func post(h http.Handler, path string) int {
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, nil))
	return rr.Code
}

func waitStatus(t *testing.T, h http.Handler, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for status(t, h) != want {
		if time.Now().After(deadline) {
			t.Fatalf("status never became %s, last %s", want, status(t, h))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestOverlappingResetsRunOnce(t *testing.T) {
	gate := make(chan struct{})
	wc := &fakeWC{existing: map[string]bool{}, gate: gate}
	c := NewController(wc, &fakePS{}, nil)
	h := c.Handler()
	if err := c.SeedOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if post(h, "/demo/reset") != http.StatusAccepted || post(h, "/demo/reset") != http.StatusAccepted {
		t.Fatal("both resets must return 202")
	}
	// Reset is blocked inside Terminate: seeded must stay false.
	time.Sleep(50 * time.Millisecond)
	if got := status(t, h); got != `{"seeded":false}` {
		t.Fatalf("during reset: %s", got)
	}
	// A startup seeder finishing mid-reset must not flip seeded either.
	close(gate)
	waitStatus(t, h, `{"seeded":true}`)
	if n := wc.count("terminate:"); n != len(Scenario()) {
		t.Fatalf("want one terminate pass (%d), got %d: %v", len(Scenario()), n, wc.callLog())
	}
	if n := wc.count("purge:"); n != len(Scenario()) {
		t.Fatalf("want one purge pass, got %d", n)
	}
}

func TestResetRetriesAfterFailure(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{}, termFailures: 1}
	c := NewController(wc, &fakePS{}, nil)
	c.retryDelay = time.Millisecond
	h := c.Handler()
	post(h, "/demo/reset")
	waitStatus(t, h, `{"seeded":true}`)
}

func TestResetFailureExposedInStatus(t *testing.T) {
	wc := &fakeWC{existing: map[string]bool{}, termErr: errors.New("boom")}
	c := NewController(wc, &fakePS{}, nil)
	c.retryDelay, c.resetDeadline = time.Millisecond, 100*time.Millisecond
	h := c.Handler()
	post(h, "/demo/reset")
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(status(t, h), `"error":"terminate sweep-001: boom"`) {
		if time.Now().After(deadline) {
			t.Fatalf("error never shown: %s", status(t, h))
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(status(t, h), `"seeded":false`) {
		t.Fatalf("seeded must be false: %s", status(t, h))
	}
}

func TestSeedDuringPendingResetDoesNotMarkSeeded(t *testing.T) {
	c := NewController(&fakeWC{existing: map[string]bool{}}, &fakePS{}, nil)
	c.resetting.Store(true) // a reset was accepted but has not reseeded yet
	if err := c.SeedOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := status(t, c.Handler()); got != `{"seeded":false}` {
		t.Fatalf("got %s", got)
	}
}
