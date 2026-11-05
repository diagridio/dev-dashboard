package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
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
}

// NewController builds a Controller. status may be nil (reports "UNKNOWN").
func NewController(wc workflowClient, ps payloadStore, status statusFunc) *Controller {
	return &Controller{wc: wc, ps: ps, status: status}
}

// SeedOnce seeds and marks the demo as seeded on success.
func (c *Controller) SeedOnce(ctx context.Context) error {
	if err := Seed(ctx, c.wc, c.ps); err != nil {
		return err
	}
	c.seeded.Store(true)
	return nil
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
		case <-time.After(time.Second):
		}
	}
}

// Handler serves the control contract plus the app's own routes.
func (c *Controller) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /demo/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"seeded": c.seeded.Load()})
	})
	mux.HandleFunc("POST /demo/reset", func(w http.ResponseWriter, _ *http.Request) {
		c.seeded.Store(false)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := Reset(ctx, c.wc, c.ps); err != nil {
				log.Printf("demo reset failed: %v", err)
				return
			}
			c.seeded.Store(true)
		}()
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
