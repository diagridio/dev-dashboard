//go:build integration

package workflow_test

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// BenchmarkWorkflowListStats measures one list page, a cold Stats (fresh
// service, empty cache) and a warm Stats (reused service) per backend over
// 2 000 seeded instances. Run manually; not a CI gate:
//
//	go test -tags integration -run '^$' -bench BenchmarkWorkflowListStats -benchtime 5x ./pkg/workflow
func BenchmarkWorkflowListStats(b *testing.B) {
	for _, kind := range backendKinds {
		b.Run(kind, func(b *testing.B) {
			store := openStore(b, kind)
			seedMany(b, store, 2000)
			ctx := context.Background()
			q := workflow.ListQuery{IncludeChildren: true}

			b.Run("list-page", func(b *testing.B) {
				svc := workflow.New(store, "default")
				for b.Loop() {
					_, err := svc.List(ctx, q)
					require.NoError(b, err)
				}
			})
			b.Run("stats-cold", func(b *testing.B) {
				for b.Loop() {
					_, err := workflow.New(store, "default").Stats(ctx, q)
					require.NoError(b, err)
				}
			})
			b.Run("stats-warm", func(b *testing.B) {
				svc := workflow.New(store, "default")
				_, err := svc.Stats(ctx, q)
				require.NoError(b, err)
				for b.Loop() {
					_, err := svc.Stats(ctx, q)
					require.NoError(b, err)
				}
			})
		})
	}
}
