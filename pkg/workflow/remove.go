package workflow

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

const WorkflowComponent = "dapr"

type RemoveTarget struct {
	AppID      string
	InstanceID string
	Status     Status
	HTTPPort   int
	// DaprHTTPBaseURL, when set (aspire-discovered apps), replaces
	// http://127.0.0.1:<HTTPPort> for the terminate/purge calls.
	DaprHTTPBaseURL string
	Healthy         bool
	// Namespace, when non-empty (aspire per-app DEVDASHBOARD_APP_<i>_NAMESPACE),
	// scopes the force-delete state-key pattern to the app's own namespace.
	// Empty (host-scanned apps) falls back to the remover's store namespace.
	Namespace string
}

type RemoveResult struct {
	InstanceID string    `json:"instanceId"`
	Mechanism  Mechanism `json:"mechanism"`
	OK         bool      `json:"ok"`
	Error      string    `json:"error,omitempty"`
}

type Remover struct {
	client    *http.Client
	store     statestore.Store
	namespace string
}

func NewRemover(client *http.Client, store statestore.Store, namespace string) *Remover {
	if namespace == "" {
		namespace = "default"
	}
	return &Remover{client: client, store: store, namespace: namespace}
}

func (r *Remover) Remove(ctx context.Context, t RemoveTarget, force bool) RemoveResult {
	log := slog.Default().With("component", "workflow")
	reachable := t.Healthy && (t.HTTPPort > 0 || t.DaprHTTPBaseURL != "")
	mech := SelectMechanism(t.Status, reachable, force)
	res := RemoveResult{InstanceID: t.InstanceID, Mechanism: mech}
	log.Info("workflow removal requested", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech), "force", force)
	var err error
	switch mech {
	case MechPurge:
		err = r.purge(ctx, t)
	case MechTerminateThenPurge:
		if err = r.terminate(ctx, t); err == nil {
			err = r.purge(ctx, t)
		}
	case MechForce:
		err = r.forceDelete(ctx, t)
	}
	if err != nil {
		res.Error = err.Error()
		log.Error("workflow removal failed", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech), "err", err)
		return res
	}
	res.OK = true
	log.Info("workflow removed", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech))
	return res
}

func (r *Remover) RemoveMany(ctx context.Context, targets []RemoveTarget, force bool) []RemoveResult {
	out := make([]RemoveResult, 0, len(targets))
	ok := 0
	for _, t := range targets {
		res := r.Remove(ctx, t, force)
		if res.OK {
			ok++
		}
		out = append(out, res)
	}
	slog.Default().With("component", "workflow").Info("bulk removal complete",
		"total", len(targets), "ok", ok, "failed", len(targets)-ok)
	return out
}

func (r *Remover) terminate(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t, "terminate")
}

func (r *Remover) purge(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t, "purge")
}

func (r *Remover) post(ctx context.Context, t RemoveTarget, action string) error {
	base := t.DaprHTTPBaseURL
	if base == "" {
		base = fmt.Sprintf("http://127.0.0.1:%d", t.HTTPPort)
	}
	u := fmt.Sprintf("%s/v1.0-beta1/workflows/%s/%s/%s", base, WorkflowComponent, t.InstanceID, action)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: status %d: %s", action, resp.StatusCode, string(b))
	}
	return nil
}

func (r *Remover) forceDelete(ctx context.Context, t RemoveTarget) error {
	if r.store == nil {
		slog.Default().With("component", "workflow").Warn("force delete unavailable", "app", t.AppID, "instance", t.InstanceID)
		return fmt.Errorf("force delete unavailable: no state store")
	}
	ns := r.namespace
	if t.Namespace != "" {
		ns = t.Namespace
	}
	keys, _, err := r.store.Keys(ctx, statestore.InstanceKeyPattern(ns, t.AppID, t.InstanceID), "", 0)
	if err != nil {
		return err
	}
	for _, k := range keys {
		if err := r.store.Delete(ctx, k); err != nil {
			return fmt.Errorf("delete %s: %w", k, err)
		}
	}
	return nil
}
