//go:build integration

package statestore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/wait"
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
	ctx := context.Background()

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
	ctx := context.Background()

	c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("dapr"),
		tcpostgres.WithUsername("dapr"),
		tcpostgres.WithPassword("dapr"),
		testcontainers.WithWaitStrategy(
			wait.ForListeningPort("5432/tcp"),
		),
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
