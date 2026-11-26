//go:build unit

package actors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func intPtr(i int) *int { return &i }

func TestForTypeUsesEntityConfig(t *testing.T) {
	cfg, err := ParseAppConfig([]byte(`{
		"entities": ["Deck", "Other"],
		"actorIdleTimeout": "1h",
		"entitiesConfig": [
			{"entities": ["Deck"], "actorIdleTimeout": "5m", "reentrancy": {"enabled": true, "maxStackDepth": 8}}
		]
	}`))
	require.NoError(t, err)

	assert.Equal(t, TypeConfig{
		IdleTimeout: "5m",
		Reentrancy:  Reentrancy{Enabled: true, MaxStackDepth: intPtr(8)},
	}, cfg.ForType("Deck"))
	assert.Equal(t, TypeConfig{IdleTimeout: "1h"}, cfg.ForType("Other"))
}

func TestForTypeDefault(t *testing.T) {
	assert.Equal(t, TypeConfig{IdleTimeout: "60m", IdleTimeoutDefault: true}, AppConfig{}.ForType("X"))
}

func TestParseAppConfigRejectsHTML(t *testing.T) {
	_, err := ParseAppConfig([]byte("<html><body>nope</body></html>"))
	assert.Error(t, err)
}

func instanceFor(t *testing.T, srv *httptest.Server, started string) discovery.Instance {
	t.Helper()
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return discovery.Instance{AppID: "app", InstanceKey: "app", AppPort: port, AppStartedAt: started}
}

func TestConfigReaderUnsupported(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer srv.Close()
	r := NewConfigReader(srv.Client(), time.Minute)

	for _, proto := range []string{"grpc", "grpcs"} {
		in := instanceFor(t, srv, "t0")
		in.AppProtocol = proto
		_, err := r.Get(context.Background(), in)
		assert.ErrorIs(t, err, ErrConfigUnsupported, proto)
	}

	in := instanceFor(t, srv, "t0")
	in.AppPort = 0
	_, err := r.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	assert.Zero(t, hits.Load())
}

func TestConfigReaderTimeoutAndCache(t *testing.T) {
	var slowHits atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slowHits.Add(1)
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()

	rd := NewConfigReader(slow.Client(), time.Minute)
	in := instanceFor(t, slow, "t0")
	start := time.Now()
	_, err := rd.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	assert.Less(t, time.Since(start), 1500*time.Millisecond)
	assert.EqualValues(t, 1, slowHits.Load())

	_, err = rd.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	assert.EqualValues(t, 1, slowHits.Load(), "failure cached within failTTL")

	var okHits atomic.Int32
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		okHits.Add(1)
		assert.Equal(t, "/dapr/config", r.URL.Path)
		_, _ = w.Write([]byte(`{"entities":["Deck"],"actorIdleTimeout":"2m"}`))
	}))
	defer ok.Close()
	rd2 := NewConfigReader(ok.Client(), time.Minute)
	in2 := instanceFor(t, ok, "t0")
	cfg, err := rd2.Get(context.Background(), in2)
	require.NoError(t, err)
	assert.Equal(t, "2m", cfg.ActorIdleTimeout)
	_, err = rd2.Get(context.Background(), in2)
	require.NoError(t, err)
	assert.EqualValues(t, 1, okHits.Load(), "success cached")

	in2.AppStartedAt = "t1"
	_, err = rd2.Get(context.Background(), in2)
	require.NoError(t, err)
	assert.EqualValues(t, 2, okHits.Load(), "new AppStartedAt refetches")
}

func TestParseAppConfigRequiresEntities(t *testing.T) {
	_, err := ParseAppConfig([]byte(`{"status":"ok"}`))
	assert.Error(t, err, "JSON without an entities key is not Dapr config")

	cfg, err := ParseAppConfig([]byte(`{"entities":[]}`))
	require.NoError(t, err)
	assert.Empty(t, cfg.Entities)
}

func countingServer(t *testing.T, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestConfigReaderNonConfigJSONIsUnreachable(t *testing.T) {
	srv, _ := countingServer(t, `{"status":"ok"}`)
	r := NewConfigReader(srv.Client(), time.Minute)
	_, err := r.Get(context.Background(), instanceFor(t, srv, "t0"))
	assert.ErrorIs(t, err, ErrConfigUnreachable)
}

func TestConfigReaderSkipsCompose(t *testing.T) {
	srv, hits := countingServer(t, `{"entities":["Deck"]}`)
	r := NewConfigReader(srv.Client(), time.Minute)
	in := instanceFor(t, srv, "t0")
	in.Source = discovery.SourceCompose
	_, err := r.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	assert.Zero(t, hits.Load(), "compose AppPort is the in-container port; no request")
}

func TestConfigReaderCancelledCallerNotCached(t *testing.T) {
	srv, hits := countingServer(t, `{"entities":["Deck"]}`)
	r := NewConfigReader(srv.Client(), time.Minute)
	in := instanceFor(t, srv, "t0")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := r.Get(ctx, in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)

	cfg, err := r.Get(context.Background(), in)
	require.NoError(t, err, "a cancelled caller must not cache a failure")
	assert.Equal(t, []string{"Deck"}, cfg.Entities)
	assert.EqualValues(t, 1, hits.Load())
}

func TestConfigReaderFailureExpires(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"entities":["Deck"]}`))
	}))
	defer srv.Close()
	r := NewConfigReader(srv.Client(), 50*time.Millisecond)
	in := instanceFor(t, srv, "t0")

	_, err := r.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	_, err = r.Get(context.Background(), in)
	assert.ErrorIs(t, err, ErrConfigUnreachable)
	assert.EqualValues(t, 1, hits.Load(), "failure cached within failTTL")

	fail.Store(false)
	time.Sleep(80 * time.Millisecond)
	_, err = r.Get(context.Background(), in)
	require.NoError(t, err, "failure refetched after failTTL")
	assert.EqualValues(t, 2, hits.Load())
}

func TestConfigReaderNoStartTimeSuccessExpires(t *testing.T) {
	srv, hits := countingServer(t, `{"entities":["Deck"]}`)
	r := NewConfigReader(srv.Client(), 50*time.Millisecond)
	in := instanceFor(t, srv, "")

	_, err := r.Get(context.Background(), in)
	require.NoError(t, err)
	_, err = r.Get(context.Background(), in)
	require.NoError(t, err)
	assert.EqualValues(t, 1, hits.Load(), "success cached within failTTL")

	time.Sleep(80 * time.Millisecond)
	_, err = r.Get(context.Background(), in)
	require.NoError(t, err)
	assert.EqualValues(t, 2, hits.Load(), "without AppStartedAt a success expires after failTTL")
}

func TestConfigReaderPrunesOldStartTimes(t *testing.T) {
	srv, _ := countingServer(t, `{"entities":["Deck"]}`)
	r := NewConfigReader(srv.Client(), time.Minute)
	in := instanceFor(t, srv, "t0")
	other := instanceFor(t, srv, "t0")
	other.InstanceKey = "app2"

	for _, started := range []string{"t0", "t1", "t2"} {
		in.AppStartedAt = started
		_, err := r.Get(context.Background(), in)
		require.NoError(t, err)
	}
	_, err := r.Get(context.Background(), other)
	require.NoError(t, err)

	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]string, 0, len(r.cache))
	for k := range r.cache {
		keys = append(keys, k)
	}
	assert.ElementsMatch(t, []string{"app|t2", "app2|t0"}, keys)
}
