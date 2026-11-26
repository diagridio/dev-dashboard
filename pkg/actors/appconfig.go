package actors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// DefaultIdleTimeout is Dapr's default actor idle timeout.
const DefaultIdleTimeout = "60m"

var (
	// ErrConfigUnsupported means the app speaks gRPC, so /dapr/config cannot be read over HTTP.
	ErrConfigUnsupported = errors.New("gRPC app: no /dapr/config")
	// ErrConfigUnreachable means the app's /dapr/config did not answer with valid config.
	ErrConfigUnreachable = errors.New("app config not reachable")
)

const configRequestTimeout = time.Second

// Reentrancy is an actor reentrancy setting.
type Reentrancy struct {
	Enabled       bool `json:"enabled"`
	MaxStackDepth *int `json:"maxStackDepth,omitempty"`
}

// EntityConfig is a per-entity override in the app's /dapr/config.
type EntityConfig struct {
	Entities         []string   `json:"entities"`
	ActorIdleTimeout string     `json:"actorIdleTimeout"`
	Reentrancy       Reentrancy `json:"reentrancy"`
}

// AppConfig is the app's /dapr/config response.
type AppConfig struct {
	Entities         []string       `json:"entities"`
	ActorIdleTimeout string         `json:"actorIdleTimeout"`
	Reentrancy       Reentrancy     `json:"reentrancy"`
	EntitiesConfig   []EntityConfig `json:"entitiesConfig"`
}

// TypeConfig is the effective configuration for one actor type.
type TypeConfig struct {
	IdleTimeout        string     `json:"idleTimeout"`
	IdleTimeoutDefault bool       `json:"idleTimeoutDefault"`
	Reentrancy         Reentrancy `json:"reentrancy"`
}

// ParseAppConfig decodes a /dapr/config body. Non-JSON bodies (such as an
// HTML page from an app that answers every path) and JSON without an
// "entities" key (some other endpoint) are rejected.
func ParseAppConfig(b []byte) (AppConfig, error) {
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		return AppConfig{}, fmt.Errorf("parse app config: %w", err)
	}
	if _, ok := keys["entities"]; !ok {
		return AppConfig{}, errors.New("parse app config: no entities key")
	}
	var c AppConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return AppConfig{}, fmt.Errorf("parse app config: %w", err)
	}
	return c, nil
}

// ForType returns the effective config for an actor type: the matching
// entitiesConfig entry wins, then the top-level values, then Dapr's default.
func (c AppConfig) ForType(actorType string) TypeConfig {
	tc := TypeConfig{IdleTimeout: c.ActorIdleTimeout, Reentrancy: c.Reentrancy}
	for _, ec := range c.EntitiesConfig {
		if slices.Contains(ec.Entities, actorType) {
			tc.Reentrancy = ec.Reentrancy
			if ec.ActorIdleTimeout != "" {
				tc.IdleTimeout = ec.ActorIdleTimeout
			}
			break
		}
	}
	if tc.IdleTimeout == "" {
		tc.IdleTimeout = DefaultIdleTimeout
		tc.IdleTimeoutDefault = true
	} else {
		tc.IdleTimeout = compactDuration(tc.IdleTimeout)
	}
	return tc
}

type configEntry struct {
	cfg     AppConfig
	failed  bool
	expires time.Time // zero: a success that lasts until AppStartedAt changes
}

// ConfigReader fetches and caches apps' /dapr/config.
type ConfigReader struct {
	client  *http.Client
	failTTL time.Duration

	mu    sync.Mutex
	cache map[string]configEntry
}

// NewConfigReader returns a reader that caches successes until the instance's
// AppStartedAt changes and failures for failTTL. When AppStartedAt is unknown,
// successes are cached for failTTL too.
func NewConfigReader(client *http.Client, failTTL time.Duration) *ConfigReader {
	return &ConfigReader{client: client, failTTL: failTTL, cache: map[string]configEntry{}}
}

// Get returns the app's config. gRPC apps yield ErrConfigUnsupported; any
// other failure yields ErrConfigUnreachable. Compose apps are not read: their
// AppPort is the in-container port, so 127.0.0.1:<AppPort> could be another app.
func (r *ConfigReader) Get(ctx context.Context, in discovery.Instance) (AppConfig, error) {
	if p := strings.ToLower(in.AppProtocol); p == "grpc" || p == "grpcs" {
		return AppConfig{}, ErrConfigUnsupported
	}
	if in.AppPort <= 0 || in.Source == discovery.SourceCompose {
		return AppConfig{}, ErrConfigUnreachable
	}

	prefix := in.InstanceKey
	if prefix == "" {
		prefix = in.AppID
	}
	prefix += "|"
	key := prefix + in.AppStartedAt

	r.mu.Lock()
	e, ok := r.cache[key]
	r.mu.Unlock()
	if ok && (e.expires.IsZero() || time.Now().Before(e.expires)) {
		if e.failed {
			return AppConfig{}, ErrConfigUnreachable
		}
		return e.cfg, nil
	}

	cfg, err := r.fetch(ctx, in.AppPort)
	if err != nil && ctx.Err() != nil {
		// The caller went away; that says nothing about the app.
		return AppConfig{}, ErrConfigUnreachable
	}
	entry := configEntry{cfg: cfg}
	if err != nil {
		entry = configEntry{failed: true, expires: time.Now().Add(r.failTTL)}
	} else if in.AppStartedAt == "" {
		entry.expires = time.Now().Add(r.failTTL)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for k := range r.cache {
		if k != key && strings.HasPrefix(k, prefix) {
			delete(r.cache, k)
		}
	}
	r.cache[key] = entry
	if err != nil {
		return AppConfig{}, ErrConfigUnreachable
	}
	return cfg, nil
}

func (r *ConfigReader) fetch(ctx context.Context, port int) (AppConfig, error) {
	ctx, cancel := context.WithTimeout(ctx, configRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/dapr/config", port), nil)
	if err != nil {
		return AppConfig{}, err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return AppConfig{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return AppConfig{}, fmt.Errorf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return AppConfig{}, err
	}
	return ParseAppConfig(body)
}
