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
// HTML page from an app that answers every path) are rejected.
func ParseAppConfig(b []byte) (AppConfig, error) {
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
	}
	return tc
}

type configEntry struct {
	cfg     AppConfig
	failed  bool
	expires time.Time // failures only
}

// ConfigReader fetches and caches apps' /dapr/config.
type ConfigReader struct {
	client  *http.Client
	failTTL time.Duration

	mu    sync.Mutex
	cache map[string]configEntry
}

// NewConfigReader returns a reader that caches successes until the instance's
// AppStartedAt changes and failures for failTTL.
func NewConfigReader(client *http.Client, failTTL time.Duration) *ConfigReader {
	return &ConfigReader{client: client, failTTL: failTTL, cache: map[string]configEntry{}}
}

// Get returns the app's config. gRPC apps yield ErrConfigUnsupported; any
// other failure yields ErrConfigUnreachable.
func (r *ConfigReader) Get(ctx context.Context, in discovery.Instance) (AppConfig, error) {
	if p := strings.ToLower(in.AppProtocol); p == "grpc" || p == "grpcs" {
		return AppConfig{}, ErrConfigUnsupported
	}
	if in.AppPort <= 0 {
		return AppConfig{}, ErrConfigUnreachable
	}

	key := in.InstanceKey
	if key == "" {
		key = in.AppID
	}
	key += "|" + in.AppStartedAt

	r.mu.Lock()
	e, ok := r.cache[key]
	r.mu.Unlock()
	if ok {
		if !e.failed {
			return e.cfg, nil
		}
		if time.Now().Before(e.expires) {
			return AppConfig{}, ErrConfigUnreachable
		}
	}

	cfg, err := r.fetch(ctx, in.AppPort)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.cache[key] = configEntry{failed: true, expires: time.Now().Add(r.failTTL)}
		return AppConfig{}, ErrConfigUnreachable
	}
	r.cache[key] = configEntry{cfg: cfg}
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
