package main

import (
	"context"
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
