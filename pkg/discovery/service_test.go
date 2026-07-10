//go:build unit

package discovery

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestServiceListEnriches(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.14.4","extended":{"appPID":"48213","appCommand":"go run ./cmd/order"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "order", HTTPPort: port, GRPCPort: 50001, AppPort: 8080, DaprdPID: 48230, Created: time.Now(), Command: "go run ./cmd/order"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second}).(*service)
	svc.pidAlive = func(int) bool { return true } // fake PID in fixture isn't a real live process

	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1)
	got := list[0]
	require.Equal(t, "order", got.AppID)
	require.Equal(t, HealthHealthy, got.Health)
	require.True(t, got.MetadataOK)
	require.Equal(t, 48213, got.AppPID)
	require.Equal(t, "1.14.4", got.RuntimeVersion)
	require.Equal(t, "go", got.Runtime)

	one, err := svc.Get(context.Background(), "order")
	require.NoError(t, err)
	require.Equal(t, "order", one.AppID)

	_, err = svc.Get(context.Background(), "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestServiceEnrichCarriesMetadataCollections(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.18.0","enabledFeatures":["StateStore"],"actors":[{"type":"OrderActor","count":2}],"components":[{"name":"statestore","type":"state.redis","version":"v1"}],"subscriptions":[{"pubsubname":"pubsub","topic":"orders"}],"actorRuntime":{"placement":"connected"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "order", HTTPPort: port, Command: "go run ./cmd/order"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	in := list[0]
	require.Equal(t, []string{"StateStore"}, in.EnabledFeatures)
	require.Equal(t, "OrderActor", in.Actors[0].Type)
	require.Equal(t, "statestore", in.Components[0].Name)
	require.Equal(t, "orders", in.Subscriptions[0].Topic)
	require.Equal(t, "connected", in.Placement)
}

func TestServiceListMetadataDown(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "x", HTTPPort: 1, DaprdPID: 9, Command: "python app.py"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 100 * time.Millisecond})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.False(t, list[0].MetadataOK)
	require.Equal(t, HealthUnhealthy, list[0].Health)
	require.Equal(t, "python", list[0].Runtime) // inferred from scan command
	require.Equal(t, 0, list[0].AppPID)         // unknown
}

func TestServiceListConcurrentEnrich(t *testing.T) {
	// One shared httptest server responds for all five fake apps.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"app","runtimeVersion":"1.14.4","extended":{"appPID":"100","appCommand":"go run ./cmd/app"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	appIDs := []string{"echo", "alpha", "delta", "bravo", "charlie"}
	scan := func() ([]ScanResult, error) {
		results := make([]ScanResult, len(appIDs))
		for i, id := range appIDs {
			results[i] = ScanResult{AppID: id, HTTPPort: port, Command: "go run ./cmd/" + id}
		}
		return results, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})

	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 5)

	// Must be sorted by AppID.
	for i := 1; i < len(list); i++ {
		require.Less(t, list[i-1].AppID, list[i].AppID, "list must be sorted by AppID")
	}

	// Every instance must be enriched (MetadataOK, HealthHealthy).
	for _, inst := range list {
		require.True(t, inst.MetadataOK, "expected MetadataOK for %s", inst.AppID)
		require.Equal(t, HealthHealthy, inst.Health, "expected HealthHealthy for %s", inst.AppID)
	}
}

func TestServiceGetFastPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"target","runtimeVersion":"1.15.0","extended":{"appPID":"200","appCommand":"go run ./cmd/target"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "other", HTTPPort: 1, Command: "go run ./cmd/other"},
			{AppID: "target", HTTPPort: port, Command: "go run ./cmd/target"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})

	// Get returns the right instance.
	inst, err := svc.Get(context.Background(), "target")
	require.NoError(t, err)
	require.Equal(t, "target", inst.AppID)
	require.True(t, inst.MetadataOK)

	// Get returns ErrNotFound for unknown appID.
	_, err = svc.Get(context.Background(), "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestList_LogsScanFailure(t *testing.T) {
	buf := captureLogs(t)
	svc := New(func() ([]ScanResult, error) { return nil, errors.New("boom") }, &http.Client{})
	_, err := svc.List(context.Background())
	if err == nil {
		t.Fatal("expected error from List")
	}
	if !strings.Contains(buf.String(), "app scan failed") {
		t.Fatalf("expected 'app scan failed' ERROR, got %q", buf.String())
	}
}

func TestList_LogsDiscoveredCount(t *testing.T) {
	buf := captureLogs(t)
	svc := New(func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "a", HTTPPort: 0}}, nil
	}, &http.Client{Timeout: 1}) // 1ns: force immediate timeout — we only assert the discovered-count log
	_, _ = svc.List(context.Background())
	if !strings.Contains(buf.String(), "discovered Dapr apps") {
		t.Fatalf("expected 'discovered Dapr apps' INFO, got %q", buf.String())
	}
}

func TestEnrichComposeUnreachableSkipsHTTP(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
	}))
	defer srv.Close()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "x", Source: SourceCompose, SidecarReachable: false, HTTPPort: port}}, nil
	}
	svc := New(scan, srv.Client())
	apps, err := svc.List(context.Background())
	if err != nil || len(apps) != 1 {
		t.Fatalf("%v %v", apps, err)
	}
	in := apps[0]
	if calls != 0 {
		t.Fatalf("unreachable sidecar must not be probed, got %d calls", calls)
	}
	if in.Health != HealthUnknown || in.MetadataOK || in.SidecarReachable {
		t.Fatalf("degraded fields: %+v", in)
	}
	if in.Source != SourceCompose {
		t.Fatalf("source: %+v", in)
	}
}

func TestEnrichComposeCarriesContainerFields(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "primes-go", Source: SourceCompose, SidecarReachable: false,
			ComposeProject: "saga", ComposeService: "primes-go-dapr",
			DaprdContainerID: "aaa", DaprdContainerName: "saga-primes-go-dapr-1",
			AppContainerID: "bbb", AppContainerName: "saga-primes-go-1",
			AppImage: "python:3.12-slim",
		}}, nil
	}
	svc := New(scan, http.DefaultClient)
	apps, err := svc.List(context.Background())
	if err != nil || len(apps) != 1 {
		t.Fatalf("List failed: %v (apps: %v)", err, apps)
	}
	in := apps[0]
	if in.ComposeProject != "saga" || in.DaprdContainerID != "aaa" || in.AppContainerName != "saga-primes-go-1" {
		t.Fatalf("container fields lost: %+v", in)
	}
	if in.Runtime != "python" {
		t.Fatalf("runtime from image: %q", in.Runtime)
	}
	if in.IsAspire {
		t.Fatalf("compose app must never be Aspire: %+v", in)
	}
}

func TestHumanAge(t *testing.T) {
	now := time.Now()
	t.Run("zero time -> empty", func(t *testing.T) {
		require.Equal(t, "", humanAge(time.Time{}))
	})
	t.Run("seconds", func(t *testing.T) {
		require.Equal(t, "5s", humanAge(now.Add(-5*time.Second)))
	})
	t.Run("minutes", func(t *testing.T) {
		require.Equal(t, "5m", humanAge(now.Add(-5*time.Minute)))
	})
	t.Run("hours", func(t *testing.T) {
		require.Equal(t, "5h", humanAge(now.Add(-5*time.Hour)))
	})
	t.Run("just under a day stays hours", func(t *testing.T) {
		require.Equal(t, "23h", humanAge(now.Add(-23*time.Hour-30*time.Minute)))
	})
	t.Run("days", func(t *testing.T) {
		require.Equal(t, "3d", humanAge(now.Add(-72*time.Hour-time.Minute)))
	})
	t.Run("negative clamps to 0s", func(t *testing.T) {
		require.Equal(t, "0s", humanAge(now.Add(5*time.Second)))
	})
}

func TestScanResultKey(t *testing.T) {
	t.Run("compose uses app container name", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose, AppContainerName: "daprmq-host-1", DaprdContainerName: "daprmq-host-1-dapr"}
		require.Equal(t, "daprmq-host-1", r.Key())
	})
	t.Run("compose falls back to daprd container name", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose, DaprdContainerName: "daprmq-host-1-dapr"}
		require.Equal(t, "daprmq-host-1-dapr", r.Key())
	})
	t.Run("compose falls back to app id", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose}
		require.Equal(t, "daprmq-service", r.Key())
	})
	t.Run("standalone always keys by app id", func(t *testing.T) {
		r := ScanResult{AppID: "order", Source: SourceStandalone, AppContainerName: "ignored"}
		require.Equal(t, "order", r.Key())
	})
	t.Run("empty source keys by app id", func(t *testing.T) {
		require.Equal(t, "order", ScanResult{AppID: "order"}.Key())
	})
}

func TestListSetsInstanceKeyAndSortsWithinAppID(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-host-2"},
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-gateway-1"},
			{AppID: "aaa-app"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 3)
	require.Equal(t, "aaa-app", list[0].AppID)
	require.Equal(t, "aaa-app", list[0].InstanceKey) // standalone: key == app id
	require.Equal(t, "daprmq-gateway-1", list[1].InstanceKey)
	require.Equal(t, "daprmq-host-2", list[2].InstanceKey)
}

func TestGetResolvesInstanceKeyThenAppID(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-gateway-1", DaprdContainerID: "aaa"},
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-host-1", DaprdContainerID: "bbb"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})

	// Exact instance-key hit returns that instance, not the first app-id match.
	in, err := svc.Get(context.Background(), "daprmq-host-1")
	require.NoError(t, err)
	require.Equal(t, "bbb", in.DaprdContainerID)
	require.Equal(t, "daprmq-host-1", in.InstanceKey)

	// A plain app id falls back to the first matching instance (legacy links).
	in, err = svc.Get(context.Background(), "daprmq-service")
	require.NoError(t, err)
	require.Equal(t, "aaa", in.DaprdContainerID)

	// Unknown key still errors.
	_, err = svc.Get(context.Background(), "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestGetInstanceKeyMatchBeatsAppIDMatch(t *testing.T) {
	// "orders" is app-id of the FIRST result but instance key of the SECOND;
	// the key pass must win even though the app-id match appears earlier.
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "orders", Source: SourceCompose, SidecarReachable: false, AppContainerName: "orders-ctr", DaprdContainerID: "first"},
			{AppID: "other", Source: SourceCompose, SidecarReachable: false, AppContainerName: "orders", DaprdContainerID: "second"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})
	in, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, "second", in.DaprdContainerID)
}

func TestEnrichComposeUsesAppRuntime(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			// Scanner chain resolved: wins over image inference.
			{AppID: "a", Source: SourceCompose, SidecarReachable: false, AppRuntime: "dotnet", AppImage: "python:3.12"},
			// Chain exhausted ("unknown"): image fallback still applies.
			{AppID: "b", Source: SourceCompose, SidecarReachable: false, AppRuntime: "unknown", AppImage: "python:3.12"},
			// Field absent (older fixtures): image fallback still applies.
			{AppID: "c", Source: SourceCompose, SidecarReachable: false, AppImage: "node:22"},
		}, nil
	}
	svc := New(scan, http.DefaultClient)
	apps, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, apps, 3)
	require.Equal(t, "dotnet", apps[0].Runtime)
	require.Equal(t, "python", apps[1].Runtime)
	require.Equal(t, "node", apps[2].Runtime)
}

func TestEnrichMapsPerTargetStatusAndStartedAt(t *testing.T) {
	started := time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC)
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID:          "checkout",
			Source:         SourceCompose,
			DaprdStatus:    StatusRunning,
			AppStatus:      StatusStopped,
			DaprdStartedAt: started,
			// AppStartedAt zero: stopped targets expose no start time
		}}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Second})
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	in := items[0]
	require.Equal(t, StatusRunning, in.DaprdStatus)
	require.Equal(t, StatusStopped, in.AppStatus)
	require.Equal(t, "2026-07-09T10:00:00Z", in.DaprdStartedAt)
	require.Equal(t, "", in.AppStartedAt)
}

func TestEnrichStandaloneStatusesAndStartTimes(t *testing.T) {
	daprdStart := time.Date(2026, 7, 9, 9, 0, 0, 0, time.UTC)
	created := time.Date(2026, 7, 9, 8, 59, 0, 0, time.UTC)
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 111, Created: created, SidecarReachable: true}}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(pid int) (time.Time, bool) {
		if pid == 111 {
			return daprdStart, true
		}
		return time.Time{}, false
	}
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	in := items[0]
	require.Equal(t, StatusRunning, in.DaprdStatus)
	require.Equal(t, "2026-07-09T09:00:00Z", in.DaprdStartedAt)
	// no metadata -> app pid unknown -> app status unknown
	require.Equal(t, "", in.AppStatus)
}

func TestEnrichStandaloneFallsBackToCreatedWhenProcStartFails(t *testing.T) {
	created := time.Date(2026, 7, 9, 8, 59, 0, 0, time.UTC)
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 111, Created: created, SidecarReachable: true}}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(pid int) (time.Time, bool) {
		return time.Time{}, false // always fail
	}
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	in := items[0]
	require.Equal(t, StatusRunning, in.DaprdStatus)
	require.Equal(t, "2026-07-09T08:59:00Z", in.DaprdStartedAt)
}

// stubSidecar serves /v1.0/healthz (204) and /v1.0/metadata with the given
// extended appPID ("" omits the field). Returns the listening port.
func stubSidecar(t *testing.T, appPID string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(http.StatusNoContent)
		case "/v1.0/metadata":
			w.Header().Set("Content-Type", "application/json")
			ext := `{}`
			if appPID != "" {
				ext = fmt.Sprintf(`{"appPID":%q,"cliPID":"300"}`, appPID)
			}
			fmt.Fprintf(w, `{"id":"orders","extended":%s}`, ext)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return port
}

func standaloneScan(httpPort, appPort int) Scanner {
	return func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 200,
			HTTPPort: httpPort, AppPort: appPort, SidecarReachable: true}}, nil
	}
}

func TestEnrichDeadAppPIDMarksAppStopped(t *testing.T) {
	port := stubSidecar(t, "100")
	svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	svc.pidAlive = func(pid int) bool { return false } // 100 is dead
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	in := items[0]
	require.Equal(t, StatusStopped, in.AppStatus)
	require.Zero(t, in.AppPID, "dead PID must not be displayed")
	require.Empty(t, in.AppStartedAt)
}

func TestEnrichLiveAppPIDMarksAppRunning(t *testing.T) {
	port := stubSidecar(t, "100")
	svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	svc.pidAlive = func(pid int) bool { return pid == 100 }
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, StatusRunning, items[0].AppStatus)
	require.Equal(t, 100, items[0].AppPID)
}

func TestEnrichPortDialDecidesWhenPIDUnknown(t *testing.T) {
	for _, tc := range []struct {
		open bool
		want string
	}{{true, StatusRunning}, {false, StatusStopped}} {
		port := stubSidecar(t, "") // metadata without appPID
		svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
		svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
		svc.portOpen = func(p int) bool { require.Equal(t, 8080, p); return tc.open }
		items, err := svc.List(context.Background())
		require.NoError(t, err)
		require.Equal(t, tc.want, items[0].AppStatus)
	}
}

func TestEnrichNoLivenessSignalStaysUnknown(t *testing.T) {
	port := stubSidecar(t, "")                                                         // no appPID
	svc := New(standaloneScan(port, 0), &http.Client{Timeout: time.Second}).(*service) // no app port
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, "", items[0].AppStatus)
}
