//go:build integration

package workflow_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

// backendKinds lists every supported state store. SQLite always runs; the
// others need a healthy container provider and skip otherwise.
var backendKinds = []string{"sqlite", "redis", "postgres", "mongodb"}

// skipIfNoContainers mirrors testcontainers.SkipIfProviderIsNotHealthy but
// accepts testing.TB so benchmarks can use it too.
func skipIfNoContainers(tb testing.TB) {
	tb.Helper()
	defer func() {
		if r := recover(); r != nil {
			tb.Skipf("container provider unavailable: %v", r)
		}
	}()
	p, err := testcontainers.ProviderDocker.GetProvider()
	if err != nil {
		tb.Skipf("container provider unavailable: %v", err)
	}
	if err := p.Health(context.Background()); err != nil {
		tb.Skipf("container provider unhealthy: %v", err)
	}
}

// openStore starts (for container kinds) and opens a fresh, empty store of
// the given kind. Everything is torn down via tb.Cleanup.
func openStore(tb testing.TB, kind string) statestore.Store {
	tb.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	tb.Cleanup(cancel)

	var comp statestore.Component
	switch kind {
	case "sqlite":
		comp = statestore.Component{Name: "statestore", Type: "state.sqlite", Version: "v1",
			Metadata: map[string]string{"connectionString": filepath.Join(tb.TempDir(), "wf.db")}}
	case "redis":
		skipIfNoContainers(tb)
		c, err := tcredis.Run(ctx, "redis:7")
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		host, err := c.Host(ctx)
		require.NoError(tb, err)
		port, err := c.MappedPort(ctx, "6379/tcp")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.redis", Version: "v1",
			Metadata: map[string]string{"redisHost": host + ":" + port.Port(), "redisPassword": ""}}
	case "postgres":
		skipIfNoContainers(tb)
		c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
			tcpostgres.WithDatabase("dapr"),
			tcpostgres.WithUsername("dapr"),
			tcpostgres.WithPassword("dapr"),
			tcpostgres.BasicWaitStrategies(),
		)
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		cs, err := c.ConnectionString(ctx, "sslmode=disable")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.postgresql", Version: "v1",
			Metadata: map[string]string{"connectionString": cs}}
	case "mongodb":
		skipIfNoContainers(tb)
		c, err := tcmongo.Run(ctx, "mongo:7")
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		host, err := c.Host(ctx)
		require.NoError(tb, err)
		port, err := c.MappedPort(ctx, "27017/tcp")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.mongodb", Version: "v1",
			Metadata: map[string]string{"host": host + ":" + port.Port(), "databaseName": "daprStore"}}
	default:
		tb.Fatalf("unknown backend kind %q", kind)
	}

	store, err := statestore.New(ctx, comp)
	require.NoError(tb, err)
	tb.Cleanup(func() { _ = store.Close() })
	return store
}
