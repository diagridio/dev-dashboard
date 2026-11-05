package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// statusFunc returns a workflow's runtime status for /status-report.
type statusFunc func(ctx context.Context, id string) (string, error)

// Controller owns the seeded flag and the demo control endpoints.
type Controller struct {
	wc     workflowClient
	ps     payloadStore
	status statusFunc
	seeded atomic.Bool

	// mu serializes SeedOnce and every Reset attempt so they never interleave.
	mu sync.Mutex
	// resetting is true from the accepted POST /demo/reset until its reseed
	// finishes. A reset requested meanwhile is a no-op (still 202).
	resetting atomic.Bool
	// flagMu makes "accept a reset and clear seeded" and "seed finished, set
	// seeded unless a reset is pending" mutually exclusive.
	flagMu  sync.Mutex
	lastErr atomic.Pointer[string]

	retryDelay    time.Duration // pause between failed attempts
	resetDeadline time.Duration // total budget for one reset (with retries)
	pollInterval  time.Duration // pause between target-state checks
}

// NewController builds a Controller. status may be nil (reports "UNKNOWN").
func NewController(wc workflowClient, ps payloadStore, status statusFunc) *Controller {
	return &Controller{wc: wc, ps: ps, status: status, retryDelay: time.Second,
		resetDeadline: 2 * time.Minute, pollInterval: 500 * time.Millisecond}
}

func (c *Controller) setErr(err error) {
	if err == nil {
		c.lastErr.Store(nil)
		return
	}
	m := err.Error()
	c.lastErr.Store(&m)
}

// awaitTargets polls until every sweep reports its scenario's target status
// (see TargetStatus), so seeded means "reached", not just "scheduled". With
// no status func (tests) it returns immediately.
func (c *Controller) awaitTargets(ctx context.Context) error {
	if c.status == nil {
		return nil
	}
	for {
		pending := ""
		for _, s := range Scenario() {
			want := TargetStatus(s)
			got, err := c.status(ctx, s.ID)
			if err != nil {
				got = err.Error()
			}
			if got != want {
				pending = fmt.Sprintf("%s is %s, want %s", s.ID, got, want)
				break
			}
		}
		if pending == "" {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("sweeps did not reach their target state: %s", pending)
		case <-time.After(c.pollInterval):
		}
	}
}

// SeedOnce seeds, waits for the target states and marks the demo as seeded
// on success. It is serialized with resets; while a reset is pending it
// never flips seeded to true (the reset's own reseed does that).
func (c *Controller) SeedOnce(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	err := Seed(ctx, c.wc, c.ps)
	if err == nil {
		err = c.awaitTargets(ctx)
	}
	c.setErr(err)
	if err != nil {
		return err
	}
	c.flagMu.Lock()
	if !c.resetting.Load() {
		c.seeded.Store(true)
	}
	c.flagMu.Unlock()
	return nil
}

// resetWithRetry runs Reset until it succeeds or the deadline passes.
func (c *Controller) resetWithRetry(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, c.resetDeadline)
	defer cancel()
	for {
		c.mu.Lock()
		// A startup seed that raced the accepted reset may have stored
		// seeded=true after the handler cleared it; clear it again.
		c.seeded.Store(false)
		err := Reset(ctx, c.wc, c.ps)
		if err == nil {
			err = c.awaitTargets(ctx)
		}
		c.mu.Unlock()
		c.setErr(err)
		if err == nil {
			return nil
		}
		log.Printf("demo reset attempt failed: %v", err)
		select {
		case <-ctx.Done():
			return err
		case <-time.After(c.retryDelay):
		}
	}
}

// SeedWithRetry retries SeedOnce until it succeeds or the deadline passes
// (the sidecar may still be starting).
func (c *Controller) SeedWithRetry(ctx context.Context, deadline time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	for {
		err := c.SeedOnce(ctx)
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(c.retryDelay):
		}
	}
}

// Handler serves the control contract plus the app's own routes.
func (c *Controller) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /demo/status", func(w http.ResponseWriter, _ *http.Request) {
		body := struct {
			Seeded bool   `json:"seeded"`
			Error  string `json:"error,omitempty"`
		}{Seeded: c.seeded.Load()}
		if e := c.lastErr.Load(); e != nil && !body.Seeded {
			body.Error = *e
		}
		writeJSON(w, http.StatusOK, body)
	})
	// A reset requested while another is in flight is a no-op: the running
	// one already removes and reseeds everything. Both get 202.
	mux.HandleFunc("POST /demo/reset", func(w http.ResponseWriter, _ *http.Request) {
		c.flagMu.Lock()
		start := c.resetting.CompareAndSwap(false, true)
		if start {
			c.seeded.Store(false)
		}
		c.flagMu.Unlock()
		if start {
			go func() {
				defer c.resetting.Store(false)
				if err := c.resetWithRetry(context.Background()); err != nil {
					log.Printf("demo reset failed: %v", err)
					return
				}
				c.seeded.Store(true)
			}()
		}
		w.WriteHeader(http.StatusAccepted)
	})
	// Service invocation target used by the bridge app.
	mux.HandleFunc("POST /status-report", func(w http.ResponseWriter, r *http.Request) {
		type item struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		out := []item{}
		for _, s := range Scenario() {
			st := "UNKNOWN"
			if c.status != nil {
				if v, err := c.status(r.Context(), s.ID); err == nil {
					st = v
				}
			}
			out = append(out, item{ID: s.ID, Status: st})
		}
		writeJSON(w, http.StatusOK, map[string]any{"sweeps": out})
	})
	// Cron input binding (sweep-schedule).
	mux.HandleFunc("POST /sweep-schedule", func(w http.ResponseWriter, _ *http.Request) {
		log.Println("Scheduled sweep requested; demo is idle, ignoring")
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
