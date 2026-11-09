package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"strings"
)

const payloadStoreName = "payloads"

// workflowClient is the slice of the workflow client Seed and Reset need.
type workflowClient interface {
	Exists(ctx context.Context, id string) (bool, error)
	Schedule(ctx context.Context, name, id string, input any) error
	Terminate(ctx context.Context, id string) error
	PurgeRecursive(ctx context.Context, id string) error
}

// payloadStore uploads a file to the binary store component.
type payloadStore interface {
	Put(ctx context.Context, key string, data []byte) error
}

// TelemetryPayload returns the ~8 KB "full sensor telemetry" document that
// sweep-006 offloads to the binary store. It is generated from a fixed seed
// so its sha256 (and therefore the store key) is stable across restarts.
func TelemetryPayload() []byte {
	rng := rand.New(rand.NewPCG(1701, 1864))
	type reading struct {
		Sensor string  `json:"sensor"`
		Deck   int     `json:"deck"`
		Value  float64 `json:"value"`
		Unit   string  `json:"unit"`
		Status string  `json:"status"`
	}
	units := []string{"kPa", "K", "mSv", "TW", "ppm"}
	readings := make([]reading, 0, 96)
	for i := range 96 {
		readings = append(readings, reading{
			Sensor: fmt.Sprintf("%s-%03d", Subsystems[i%len(Subsystems)], i),
			Deck:   1 + rng.IntN(15),
			Value:  float64(rng.IntN(1000000)) / 1000,
			Unit:   units[rng.IntN(len(units))],
			Status: "nominal",
		})
	}
	b, _ := json.Marshal(map[string]any{
		"sweepId":  "sweep-006",
		"kind":     "full sensor telemetry",
		"readings": readings,
	})
	return b
}

// PayloadSHA is the hex sha256 of TelemetryPayload.
func PayloadSHA() string {
	sum := sha256.Sum256(TelemetryPayload())
	return hex.EncodeToString(sum[:])
}

// PayloadKey is the binary-store file name for the telemetry payload.
func PayloadKey() string {
	return fmt.Sprintf("workflow-payloads/sweep-006/%s", PayloadSHA())
}

// PayloadRef builds the {"$daprRef":{...}} envelope the .NET/JS SDKs produce
// for offloaded workflow payloads (the Go SDK has no data-reference support).
func PayloadRef() map[string]any {
	p := TelemetryPayload()
	return map[string]any{"$daprRef": map[string]any{
		"v": 1, "store": payloadStoreName, "key": PayloadKey(), "size": len(p), "sha256": PayloadSHA(),
	}}
}

// Seed uploads the payload (always, the in-memory store forgets on restart)
// and schedules every sweep that does not exist yet.
func Seed(ctx context.Context, wc workflowClient, ps payloadStore) error {
	if err := ps.Put(ctx, PayloadKey(), TelemetryPayload()); err != nil {
		return fmt.Errorf("upload payload: %w", err)
	}
	for _, s := range Scenario() {
		ok, err := wc.Exists(ctx, s.ID)
		if err != nil {
			return fmt.Errorf("check %s: %w", s.ID, err)
		}
		if ok {
			continue
		}
		if err := wc.Schedule(ctx, "DiagnosticSweep", s.ID, s); err != nil {
			return fmt.Errorf("schedule %s: %w", s.ID, err)
		}
	}
	return nil
}

// Reset removes every demo sweep (and its children) and seeds again.
func Reset(ctx context.Context, wc workflowClient, ps payloadStore) error {
	for _, s := range Scenario() {
		if err := wc.Terminate(ctx, s.ID); err != nil && !ignorable(err) {
			return fmt.Errorf("terminate %s: %w", s.ID, err)
		}
		if err := wc.PurgeRecursive(ctx, s.ID); err != nil && !ignorable(err) {
			return fmt.Errorf("purge %s: %w", s.ID, err)
		}
	}
	return Seed(ctx, wc, ps)
}

// ignorable reports errors that just mean "nothing to terminate/purge".
func ignorable(err error) bool {
	m := strings.ToLower(err.Error())
	return strings.Contains(m, "not running") || strings.Contains(m, "no such instance") || strings.Contains(m, "not found")
}
