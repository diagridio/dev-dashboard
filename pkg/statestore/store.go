package statestore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync/atomic"

	"github.com/dapr/components-contrib/metadata"
	"github.com/dapr/components-contrib/state"
	"github.com/dapr/components-contrib/state/mongodb"
	postgresql "github.com/dapr/components-contrib/state/postgresql/v2"
	"github.com/dapr/components-contrib/state/redis"
	"github.com/dapr/components-contrib/state/sqlite"
	"github.com/dapr/kit/logger"
)

// verbose gates the log level of the kit logger handed to the embedded
// components-contrib backends. Off (the default) suppresses their INFO
// chatter (e.g. sqlite's "Creating metadata table"); warnings and errors
// always surface.
var verbose atomic.Bool

// SetVerbose lets the backend state stores emit informational logs; wire it
// to the dashboard's --verbose flag.
func SetVerbose(v bool) { verbose.Store(v) }

// ErrUnsupported is returned by New when the component type is not one of the
// four supported backends (state.redis, state.sqlite,
// state.postgresql/postgres, state.mongodb).
var ErrUnsupported = errors.New("unsupported state store type")

// SecretRef is a Dapr secretKeyRef or envRef metadata reference.
type SecretRef struct {
	// Kind is "secretKeyRef" or "envRef", mirroring secrets.Ref.Kind. The zero
	// value ("") is treated as "secretKeyRef" by every consumer, so existing
	// literals built before envRef support was added keep working unchanged.
	Kind string
	Name string // secretKeyRef.name, or the env var name for envRef
	Key  string // secretKeyRef.key (the key within that secret); unused for envRef
}

// Component is the parsed subset of a Dapr state-store component YAML we need.
type Component struct {
	Name        string               // metadata.name
	Type        string               // spec.type, e.g. "state.redis"
	Version     string               // spec.version
	Metadata    map[string]string    // spec.metadata name->value (inline only)
	SecretRefs  map[string]SecretRef // spec.metadata name->secretKeyRef/envRef (no inline value)
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
	// Set upserts a raw byte value at key. Used by integration tests to seed state.
	Set(ctx context.Context, key string, value []byte) error
	Close() error
}

// ccStore wraps a components-contrib state.Store.
type ccStore struct {
	inner     state.Store
	storeType string
}

// New builds and initialises a components-contrib state store from a component spec.
// Supports state.redis, state.sqlite, state.postgresql / state.postgres, and state.mongodb.
// Returns ErrUnsupported for any other type.
func New(ctx context.Context, c Component) (Store, error) {
	log := logger.NewLogger("dev-dashboard")
	if verbose.Load() {
		log.SetOutputLevel(logger.InfoLevel)
	} else {
		log.SetOutputLevel(logger.WarnLevel)
	}

	var inner state.Store
	switch c.Type {
	case "state.redis":
		inner = redis.NewRedisStateStore(log)
	case "state.sqlite":
		inner = sqlite.NewSQLiteStateStore(log)
	case "state.postgresql", "state.postgres":
		inner = postgresql.NewPostgreSQLStateStore(log)
	case "state.mongodb":
		inner = mongodb.NewMongoDB(log)
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
// The backend must implement state.KeysLiker; redis, sqlite, postgres v2, and mongodb all do.
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

const (
	// bulkGetChunk caps keys per backend bulk read: well under SQLite's
	// bound-parameter limit, and small enough to keep PostgreSQL/MongoDB
	// queries cheap.
	bulkGetChunk = 100
	// bulkGetParallelism bounds concurrent Gets for backends whose BulkGet is
	// contrib's DefaultBulkStore (Redis); native implementations ignore it.
	bulkGetParallelism = 16
)

// BulkGet reads many keys through the backend's bulk path: one query per
// chunk on PostgreSQL, SQLite and MongoDB; bounded parallel Gets on Redis.
// The result has an entry for every requested key, nil when the key is
// missing. A per-key backend error fails the whole call, like Get.
func (s *ccStore) BulkGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	bs, ok := s.inner.(state.BulkStore)
	if !ok {
		// Defensive: state.Store embeds BulkStore, so every supported
		// backend takes the branch above.
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
	return bulkGetChunked(ctx, bs, keys, bulkGetChunk)
}

// bulkGetChunked issues one bs.BulkGet per chunk of keys and merges the
// responses by key (backends may return them in any order).
func bulkGetChunked(ctx context.Context, bs state.BulkStore, keys []string, chunk int) (map[string][]byte, error) {
	out := make(map[string][]byte, len(keys))
	for start := 0; start < len(keys); start += chunk {
		end := min(start+chunk, len(keys))
		reqs := make([]state.GetRequest, 0, end-start)
		for _, k := range keys[start:end] {
			reqs = append(reqs, state.GetRequest{Key: k})
			out[k] = nil
		}
		resp, err := bs.BulkGet(ctx, reqs, state.BulkGetOpts{Parallelism: bulkGetParallelism})
		if err != nil {
			return nil, err
		}
		for _, r := range resp {
			if r.Error != "" {
				return nil, fmt.Errorf("bulk get %q: %s", r.Key, r.Error)
			}
			if _, want := out[r.Key]; want {
				out[r.Key] = r.Data
			}
		}
	}
	return out, nil
}

// Delete removes a single key from the store.
func (s *ccStore) Delete(ctx context.Context, key string) error {
	return s.inner.Delete(ctx, &state.DeleteRequest{Key: key})
}

// Set upserts a raw byte value at the given key.
// This is used by integration tests to seed state.
func (s *ccStore) Set(ctx context.Context, key string, value []byte) error {
	return s.inner.Set(ctx, &state.SetRequest{Key: key, Value: value})
}

// Close shuts down the underlying store. state.BaseStore already embeds io.Closer
// so the type-assert will succeed for all four supported backends; the io.Closer
// fallback is kept as a defensive belt-and-braces guard.
func (s *ccStore) Close() error {
	if c, ok := s.inner.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// SeedForTest is a helper for integration tests that upserts a
// raw byte value through the public Store interface.
func SeedForTest(ctx context.Context, s Store, key string, value []byte) error {
	return s.Set(ctx, key, value)
}
