//go:build unit

package metadata

import (
	"math/rand/v2"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestSortComponentsIsTotalOrder: components that tie on type, status and
// title (e.g. v1/v2 of one component) must come out in the same order however
// the input is ordered, so a bundle refresh doesn't reshuffle the golden
// catalog summary.
func TestSortComponentsIsTotalOrder(t *testing.T) {
	base := []*ComponentMetadata{
		{Type: "state", Name: "redis", Version: "v2", Status: "stable", Title: "Redis"},
		{Type: "state", Name: "redis", Version: "v1", Status: "stable", Title: "Redis"},
		{Type: "state", Name: "redis.cluster", Version: "v1", Status: "stable", Title: "Redis"},
		{Type: "bindings", Name: "kafka", Version: "v1", Status: "beta", Title: "Kafka"},
		{Type: "state", Name: "azure.cosmosdb", Version: "v1", Status: "alpha", Title: "Cosmos"},
	}
	want := []string{"bindings/kafka/v1", "state/redis/v1", "state/redis/v2", "state/redis.cluster/v1", "state/azure.cosmosdb/v1"}

	rng := rand.New(rand.NewPCG(1, 2))
	for range 50 {
		in := append([]*ComponentMetadata(nil), base...)
		rng.Shuffle(len(in), func(i, j int) { in[i], in[j] = in[j], in[i] })
		b := Bundle{Components: in}
		sortComponents(&b)
		got := make([]string, len(b.Components))
		for i, c := range b.Components {
			got[i] = c.Type + "/" + c.Name + "/" + c.Version
		}
		require.Equal(t, want, got)
	}
}
