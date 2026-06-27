//go:build integration

package statestore_test

import (
	"context"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/alicebob/miniredis/v2/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// TestRedisStoreRoundTrip validates the observable contract of the Redis
// state store backend against an in-process miniredis server:
//
//   - Keys returns keys seeded through store.Set
//   - Get round-trips a value written via store.Set
//   - Delete reduces the key set by one
//
// Values are seeded through store.Set (not mr.Set) because the Redis
// components-contrib backend stores values inside an HSET hash envelope
// (fields: "data", "version", "first-write").  Seeding raw strings via
// mr.Set bypasses the envelope and causes Get to return an error.
//
// The components-contrib Redis state store also calls "INFO replication"
// during Init to count connected replicas.  miniredis v2 does not implement
// the replication section; we intercept the command via a pre-hook that
// returns a minimal valid response before the default handler runs.
func TestRedisStoreRoundTrip(t *testing.T) {
	mr := miniredis.NewMiniRedis()
	err := mr.Start()
	require.NoError(t, err)
	t.Cleanup(mr.Close)

	// Pre-hook: intercept "INFO replication" and return a minimal response so
	// the components-contrib Redis state store's getConnectedSlaves() succeeds.
	// The store only reads "connected_slaves:" from the output; returning 0 is
	// sufficient.  All other commands are passed through to the real handler.
	mr.Server().SetPreHook(func(c *server.Peer, cmd string, args ...string) bool {
		if cmd == "INFO" && len(args) == 1 && strings.ToLower(args[0]) == "replication" {
			c.WriteBulk("# Replication\r\nrole:master\r\nconnected_slaves:0\r\n")
			return true // command handled; skip default dispatch
		}
		return false // let default handler run
	})

	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.redis",
		Version: "v1",
		Metadata: map[string]string{
			"redisHost":     mr.Addr(),
			"redisPassword": "",
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	// Seed two keys through the store's own write path so the HSET envelope
	// (fields: "data", "version", "first-write") is written and Get can decode
	// the values on read-back.
	const metaKey = "k||a||1||metadata"
	const histKey = "k||a||1||history-000000"

	require.NoError(t, store.Set(context.Background(), metaKey, []byte("v1")))
	require.NoError(t, store.Set(context.Background(), histKey, []byte("v2")))

	// Keys returns both seeded keys.
	keys, _, err := store.Keys(context.Background(), "k||a||1||%", "", 0)
	require.NoError(t, err)
	require.Len(t, keys, 2)

	// Get round-trips the value for the metadata key.
	got, err := store.Get(context.Background(), metaKey)
	require.NoError(t, err)
	require.Equal(t, "v1", string(got))

	// Delete removes exactly one key; Keys now returns only the history key.
	require.NoError(t, store.Delete(context.Background(), metaKey))
	keys, _, err = store.Keys(context.Background(), "k||a||1||%", "", 0)
	require.NoError(t, err)
	require.Len(t, keys, 1)
	require.Equal(t, histKey, keys[0])
}
