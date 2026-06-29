package statestore

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/dapr/components-contrib/metadata"
	"github.com/dapr/components-contrib/state"
	postgresql "github.com/dapr/components-contrib/state/postgresql/v2"
	"github.com/dapr/components-contrib/state/redis"
	"github.com/dapr/components-contrib/state/sqlite"
	"github.com/dapr/kit/logger"
)

// ErrUnsupported is returned by New when the component type is not one of the
// three supported backends (state.redis, state.sqlite, state.postgresql/postgres).
var ErrUnsupported = errors.New("unsupported state store type")

// SecretRef is a Dapr secretKeyRef: the secret name and the key within it.
type SecretRef struct {
	Name string // secretKeyRef.name (the secret's name)
	Key  string // secretKeyRef.key (the key within that secret)
}

// Component is the parsed subset of a Dapr state-store component YAML we need.
type Component struct {
	Name        string               // metadata.name
	Type        string               // spec.type, e.g. "state.redis"
	Version     string               // spec.version
	Metadata    map[string]string    // spec.metadata name->value (inline only)
	SecretRefs  map[string]SecretRef // spec.metadata name->secretKeyRef (no inline value)
	SecretStore string               // auth.secretStore
	Path        string               // source file path (for display / disambiguation)
}

// Store is the read + write + delete surface the workflow service needs.
type Store interface {
	// Keys lists keys matching a LIKE pattern, with opaque cursor paging.
	Keys(ctx context.Context, pattern string, token string, pageSize int) (keys []string, next string, err error)
	Get(ctx context.Context, key string) ([]byte, error)
	BulkGet(ctx context.Context, keys []string) (map[string][]byte, error)
	Delete(ctx context.Context, key string) error
	// Set upserts a raw byte value at key. Required by integration tests (Task 10).
	Set(ctx context.Context, key string, value []byte) error
	Close() error
}

// ccStore wraps a components-contrib state.Store.
type ccStore struct {
	inner     state.Store
	storeType string
}

// New builds and initialises a components-contrib state store from a component spec.
// Supports state.redis, state.sqlite, and state.postgresql / state.postgres.
// Returns ErrUnsupported for any other type.
func New(ctx context.Context, c Component) (Store, error) {
	log := logger.NewLogger("dev-dashboard")

	var inner state.Store
	switch c.Type {
	case "state.redis":
		inner = redis.NewRedisStateStore(log)
	case "state.sqlite":
		inner = sqlite.NewSQLiteStateStore(log)
	case "state.postgresql", "state.postgres":
		inner = postgresql.NewPostgreSQLStateStore(log)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupported, c.Type)
	}

	if err := inner.Init(ctx, state.Metadata{
		Base: metadata.Base{
			Name:       c.Name,
			Properties: c.Metadata,
		},
	}); err != nil {
		return nil, fmt.Errorf("init %s: %w", c.Type, err)
	}

	return &ccStore{inner: inner, storeType: c.Type}, nil
}

// Keys lists state-store keys matching a SQL LIKE pattern.
// The backend must implement state.KeysLiker; redis, sqlite, and postgres v2 all do.
func (s *ccStore) Keys(ctx context.Context, pattern, token string, pageSize int) ([]string, string, error) {
	kl, ok := s.inner.(state.KeysLiker)
	if !ok {
		return nil, "", fmt.Errorf("store %q does not support key listing", s.storeType)
	}

	req := &state.KeysLikeRequest{Pattern: pattern}
	if token != "" {
		req.ContinuationToken = &token
	}
	if pageSize > 0 {
		ps := uint32(pageSize)
		req.PageSize = &ps
	}

	resp, err := kl.KeysLike(ctx, req)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if resp.ContinuationToken != nil {
		next = *resp.ContinuationToken
	}
	return resp.Keys, next, nil
}

// Get retrieves the raw bytes for a single key. Returns nil bytes if missing.
func (s *ccStore) Get(ctx context.Context, key string) ([]byte, error) {
	resp, err := s.inner.Get(ctx, &state.GetRequest{Key: key})
	if err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// BulkGet retrieves multiple keys in a sequential loop.
// For the modest local key counts targeted here, a loop is correct;
// a future optimisation can delegate to the underlying BulkStore interface.
func (s *ccStore) BulkGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	out := make(map[string][]byte, len(keys))
	for _, k := range keys {
		b, err := s.Get(ctx, k)
		if err != nil {
			return nil, err
		}
		out[k] = b
	}
	return out, nil
}

// Delete removes a single key from the store.
func (s *ccStore) Delete(ctx context.Context, key string) error {
	return s.inner.Delete(ctx, &state.DeleteRequest{Key: key})
}

// Set upserts a raw byte value at the given key.
// This is used by integration tests (Task 10) to seed state.
func (s *ccStore) Set(ctx context.Context, key string, value []byte) error {
	return s.inner.Set(ctx, &state.SetRequest{Key: key, Value: value})
}

// Close shuts down the underlying store. state.BaseStore already embeds io.Closer
// so the type-assert will succeed for all three supported backends; the io.Closer
// fallback is kept as a defensive belt-and-braces guard.
func (s *ccStore) Close() error {
	if c, ok := s.inner.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// SeedForTest is a helper for integration tests (Task 10) that upserts a
// raw byte value through the public Store interface.
func SeedForTest(ctx context.Context, s Store, key string, value []byte) error {
	return s.Set(ctx, key, value)
}
