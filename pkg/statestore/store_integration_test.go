//go:build integration

package statestore_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// Real Dapr workflow key shape: <appId>||<actorType>||<instanceId>||<suffix>.
const (
	metaKey = "k||a||1||metadata"
	histKey = "k||a||1||history-000000"
	keyLike = "k||a||1||%"
)

// runStoreContract asserts the observable Store contract against a live backend:
// seed two keys, list them by LIKE pattern, round-trip a value, delete one.
func runStoreContract(t *testing.T, store statestore.Store) {
	t.Helper()
	ctx := context.Background()

	require.NoError(t, store.Set(ctx, metaKey, []byte("v1")))
	require.NoError(t, store.Set(ctx, histKey, []byte("v2")))

	keys, _, err := store.Keys(ctx, keyLike, "", 0)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{metaKey, histKey}, keys)

	got, err := store.Get(ctx, metaKey)
	require.NoError(t, err)
	require.Equal(t, "v1", string(got))

	require.NoError(t, store.Delete(ctx, metaKey))
	keys, _, err = store.Keys(ctx, keyLike, "", 0)
	require.NoError(t, err)
	require.Equal(t, []string{histKey}, keys)

	// Records: metadata-preserving bulk read across every backend.
	rr, ok := store.(statestore.RecordReader)
	require.True(t, ok, "backend must implement RecordReader")

	recs, err := rr.Records(ctx, []string{histKey, "k||a||1||absent"})
	require.NoError(t, err)
	require.Len(t, recs, 1, "a missing key must be omitted, not returned empty")
	require.Equal(t, histKey, recs[0].Key)
	require.Equal(t, "v2", string(recs[0].Value))
	require.NotEmpty(t, recs[0].ETag, "all four backends return an etag for a written key")
	require.Nil(t, recs[0].TTLExpire, "no TTL was set on this key")

	require.Empty(t, mustRecords(t, rr, nil), "an empty key list is a no-op")

	// BulkGet parity: binary (proto) values must come back byte-identical to
	// Get on every backend (SQLite base64-encodes binary values at rest), a
	// missing key maps to nil, and >bulkGetChunk keys span several chunks.
	bin, err := proto.Marshal(wrapperspb.Bytes([]byte("binary\x00payload\xff")))
	require.NoError(t, err)
	var bulkKeys []string
	for i := 0; i < 130; i++ {
		k := fmt.Sprintf("k||a||bulk||history-%06d", i)
		require.NoError(t, store.Set(ctx, k, bin))
		bulkKeys = append(bulkKeys, k)
	}
	missing := "k||a||bulk||absent"
	got2, err := store.BulkGet(ctx, append(bulkKeys, missing))
	require.NoError(t, err)
	require.Len(t, got2, len(bulkKeys)+1)
	for _, k := range bulkKeys {
		single, err := store.Get(ctx, k)
		require.NoError(t, err)
		require.Equal(t, single, got2[k], "BulkGet bytes must equal Get bytes for %s", k)
		require.Equal(t, bin, got2[k])
	}
	require.Nil(t, got2[missing])
}

func mustRecords(t *testing.T, rr statestore.RecordReader, keys []string) []statestore.Record {
	t.Helper()
	recs, err := rr.Records(context.Background(), keys)
	require.NoError(t, err)
	return recs
}

func TestSQLiteStoreContract(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:     "statestore",
		Type:     "state.sqlite",
		Version:  "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}

func TestRedisStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	c, err := tcredis.Run(ctx, "redis:7")
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	host, err := c.Host(ctx)
	require.NoError(t, err)
	port, err := c.MappedPort(ctx, "6379/tcp")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:     "statestore",
		Type:     "state.redis",
		Version:  "v1",
		Metadata: map[string]string{"redisHost": host + ":" + port.Port(), "redisPassword": ""},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}

func TestPostgresStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("dapr"),
		tcpostgres.WithUsername("dapr"),
		tcpostgres.WithPassword("dapr"),
		// BasicWaitStrategies waits for the "ready to accept connections" log
		// twice (the official image restarts once during initdb) plus the port,
		// avoiding the connect-during-initdb race a bare port wait allows.
		tcpostgres.BasicWaitStrategies(),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	cs, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:     "statestore",
		Type:     "state.postgresql",
		Version:  "v1",
		Metadata: map[string]string{"connectionString": cs},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}

func TestMongoStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	c, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	host, err := c.Host(ctx)
	require.NoError(t, err)
	port, err := c.MappedPort(ctx, "27017/tcp")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:    "statestore",
		Type:    "state.mongodb",
		Version: "v1",
		Metadata: map[string]string{
			"host":         host + ":" + port.Port(),
			"databaseName": "daprStore",
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}
