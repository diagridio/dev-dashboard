//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
)

type fakeManager struct {
	list   controlplane.ListResult
	doErr  error
	lastDo [2]string
}

func (f *fakeManager) List(context.Context) (controlplane.ListResult, error) { return f.list, nil }
func (f *fakeManager) Do(_ context.Context, action, name string) error {
	f.lastDo = [2]string{action, name}
	return f.doErr
}
func (f *fakeManager) LogStream(context.Context, string) (<-chan string, error) {
	ch := make(chan string)
	close(ch)
	return ch, nil
}

func TestControlPlaneListRoute(t *testing.T) {
	mgr := &fakeManager{list: controlplane.ListResult{
		Available: true,
		Services:  []controlplane.Service{{Name: "dapr_scheduler", Status: controlplane.StatusRunning}},
	}}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got controlplane.ListResult
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 1 || got.Services[0].Name != "dapr_scheduler" {
		t.Errorf("body = %+v", got)
	}
}

func TestControlPlaneActionRoute(t *testing.T) {
	mgr := &fakeManager{}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodPost, "/dapr_scheduler/restart", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if mgr.lastDo != [2]string{"restart", "dapr_scheduler"} {
		t.Errorf("Do called with %v", mgr.lastDo)
	}
}

func TestControlPlaneActionBadRequest(t *testing.T) {
	mgr := &fakeManager{doErr: controlplane.ErrUnknownService}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodPost, "/dapr_redis/start", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
