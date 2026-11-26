//go:build unit

package actors

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

func sidecarInstance(t *testing.T, h http.HandlerFunc) discovery.Instance {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return discovery.Instance{DaprHTTPBaseURL: srv.URL, SidecarReachable: true}
}

func TestInvokeProxiesToSidecar(t *testing.T) {
	var method, path, ctype, body string
	in := sidecarInstance(t, func(w http.ResponseWriter, r *http.Request) {
		method, path, ctype = r.Method, r.URL.Path, r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	res, err := Invoke(context.Background(), http.DefaultClient, in, "Deck", "deck-1", InvokeRequest{Method: "Reset", Verb: "POST", Body: "{}"})
	if err != nil {
		t.Fatal(err)
	}
	if method != "POST" || path != "/v1.0/actors/Deck/deck-1/method/Reset" || ctype != "application/json" || body != "{}" {
		t.Fatalf("got %s %s %s %q", method, path, ctype, body)
	}
	if res.Status != 200 || res.Body != "{}" || res.DurationMs < 0 || res.ContentType != "application/json" || res.Error != "" {
		t.Fatalf("result = %+v", res)
	}
}

func TestInvokeEscapesSegments(t *testing.T) {
	var escaped string
	in := sidecarInstance(t, func(w http.ResponseWriter, r *http.Request) {
		escaped = r.URL.EscapedPath()
	})
	_, err := Invoke(context.Background(), http.DefaultClient, in, "Deck", "a/b c||d", InvokeRequest{Method: "Get Status", Verb: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if want := "/v1.0/actors/Deck/a%2Fb%20c%7C%7Cd/method/Get%20Status"; escaped != want {
		t.Fatalf("path = %s, want %s", escaped, want)
	}
}

func TestInvokePassesThroughNon2xx(t *testing.T) {
	raw := `{"errorCode":"ERR_ACTOR_INVOKE_METHOD","message":"boom"}`
	in := sidecarInstance(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(raw))
	})
	res, err := Invoke(context.Background(), http.DefaultClient, in, "Deck", "deck-1", InvokeRequest{Method: "Reset"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != 500 || res.Error != "boom" || res.Body != raw {
		t.Fatalf("result = %+v", res)
	}
}

func TestInvokeCapsResponseBody(t *testing.T) {
	in := sidecarInstance(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", maxBodyBytes+100)))
	})
	res, err := Invoke(context.Background(), http.DefaultClient, in, "Deck", "d", InvokeRequest{Method: "M"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Body) != maxBodyBytes {
		t.Fatalf("body len = %d", len(res.Body))
	}
}

func TestInvokeRejects(t *testing.T) {
	ok := discovery.Instance{DaprHTTPBaseURL: "http://127.0.0.1:1", SidecarReachable: true}
	ctx := context.Background()
	if _, err := Invoke(ctx, http.DefaultClient, ok, "dapr.internal.default.x.reminders", "a", InvokeRequest{Method: "M"}); !errors.Is(err, ErrInternalType) {
		t.Fatalf("internal: %v", err)
	}
	if _, err := Invoke(ctx, http.DefaultClient, ok, "Deck", "a", InvokeRequest{}); err == nil {
		t.Fatal("empty method accepted")
	}
	if _, err := Invoke(ctx, http.DefaultClient, ok, "Deck", "a", InvokeRequest{Method: "M", Verb: "PATCH"}); err == nil {
		t.Fatal("PATCH accepted")
	}
	down := discovery.Instance{DaprHTTPBaseURL: "http://127.0.0.1:1"}
	if _, err := Invoke(ctx, http.DefaultClient, down, "Deck", "a", InvokeRequest{Method: "M"}); !errors.Is(err, ErrSidecarUnreachable) {
		t.Fatalf("unreachable: %v", err)
	}
}

func TestDeleteReminder(t *testing.T) {
	var method, path string
	status := 204
	in := sidecarInstance(t, func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		w.WriteHeader(status)
		if status >= 300 {
			_, _ = w.Write([]byte(`{"errorCode":"E","message":"nope"}`))
		}
	})
	if err := DeleteReminder(context.Background(), http.DefaultClient, in, "Deck", "deck-1", "heartbeat"); err != nil {
		t.Fatal(err)
	}
	if method != "DELETE" || path != "/v1.0/actors/Deck/deck-1/reminders/heartbeat" {
		t.Fatalf("got %s %s", method, path)
	}
	status = 500
	err := DeleteReminder(context.Background(), http.DefaultClient, in, "Deck", "deck-1", "heartbeat")
	if err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v", err)
	}
	if err := DeleteReminder(context.Background(), http.DefaultClient, in, "dapr.internal.x", "a", "r"); !errors.Is(err, ErrInternalType) {
		t.Fatalf("internal: %v", err)
	}
}

func TestDaprdErrorMessage(t *testing.T) {
	cases := map[string]string{
		`{"errorCode":"E","message":"m"}`: "m",
		`{"errorCode":"E"}`:               "E",
		`  plain text  `:                  "plain text",
	}
	for in, want := range cases {
		if got := DaprdErrorMessage([]byte(in)); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}
