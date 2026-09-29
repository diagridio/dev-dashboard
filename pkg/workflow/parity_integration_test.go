//go:build integration

package workflow_test

import (
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// legacyLoadAll reimplements the pre-#93 loader (scan every instance's keys,
// Get each value) as the reference the new path must match.
func legacyLoadAll(t *testing.T, store statestore.Store, ns string) map[string]workflow.Execution {
	t.Helper()
	ctx := context.Background()
	metaKeys, _, err := store.Keys(ctx, statestore.AllInstanceMetaPattern(ns), "", 0)
	require.NoError(t, err)
	out := map[string]workflow.Execution{}
	for _, mk := range metaKeys {
		appID, ok := statestore.ParseAppID(mk)
		require.True(t, ok)
		id, ok := statestore.ParseInstanceID(mk)
		require.True(t, ok)
		keys, _, err := store.Keys(ctx, statestore.InstanceKeyPattern(ns, appID, id), "", 0)
		require.NoError(t, err)
		prefix := statestore.InstancePrefix(ns, appID, id)
		var hkeys []string
		cs := ""
		vals := map[string][]byte{}
		for _, k := range keys {
			v, err := store.Get(ctx, k)
			require.NoError(t, err)
			vals[k] = v
			suffix := strings.TrimPrefix(k, prefix)
			switch {
			case strings.HasPrefix(suffix, statestore.HistoryPrefix):
				hkeys = append(hkeys, k)
			case suffix == statestore.SuffixCustomStatus:
				cs = string(v)
			}
		}
		sort.Strings(hkeys)
		var history []*protos.HistoryEvent
		for _, hk := range hkeys {
			var e protos.HistoryEvent
			require.NoError(t, proto.Unmarshal(vals[hk], &e))
			history = append(history, &e)
		}
		out[appID+"/"+id] = workflow.DecodeExecution(appID, id, history, cs)
	}
	return out
}

func summariesOf(m map[string]workflow.Execution, keep func(workflow.ExecutionSummary) bool) []workflow.ExecutionSummary {
	var out []workflow.ExecutionSummary
	for _, ex := range m {
		if keep(ex.ExecutionSummary) {
			out = append(out, ex.ExecutionSummary)
		}
	}
	sortSummaries(out)
	return out
}

func sortSummaries(s []workflow.ExecutionSummary) {
	sort.Slice(s, func(a, b int) bool {
		if s[a].AppID != s[b].AppID {
			return s[a].AppID < s[b].AppID
		}
		return s[a].InstanceID < s[b].InstanceID
	})
}

// listAll pages List to the end (NextToken == "").
func listAll(t *testing.T, svc workflow.Service, q workflow.ListQuery) []workflow.ExecutionSummary {
	t.Helper()
	var all []workflow.ExecutionSummary
	for {
		res, err := svc.List(context.Background(), q)
		require.NoError(t, err)
		all = append(all, res.Items...)
		if res.NextToken == "" {
			break
		}
		q.PageToken = res.NextToken
	}
	sortSummaries(all)
	return all
}

func TestWorkflowReadParityAcrossBackends(t *testing.T) {
	for _, kind := range backendKinds {
		t.Run(kind, func(t *testing.T) {
			store := openStore(t, kind)
			seedMany(t, store, 200)
			want := legacyLoadAll(t, store, "default")
			require.Len(t, want, 200)

			svc := workflow.New(store, "default")
			all := func(workflow.ExecutionSummary) bool { return true }
			roots := func(s workflow.ExecutionSummary) bool { return s.ParentInstanceID == "" }

			// List, paged, with and without children.
			require.Equal(t, summariesOf(want, all),
				listAll(t, svc, workflow.ListQuery{IncludeChildren: true, PageSize: 25}))
			require.Equal(t, summariesOf(want, roots),
				listAll(t, svc, workflow.ListQuery{IncludeChildren: false, PageSize: 25}))

			// Stats, cold then warm (cached), must match the reference counts.
			wantCounts := map[workflow.Status]int{}
			for _, ex := range want {
				wantCounts[ex.Status]++
			}
			for pass := 0; pass < 2; pass++ {
				st, err := svc.Stats(context.Background(), workflow.ListQuery{IncludeChildren: true})
				require.NoError(t, err)
				require.Equal(t, 200, st.Total, "pass %d", pass)
				require.Equal(t, wantCounts, st.Counts, "pass %d", pass)
			}

			// Get: 150-event instance (spans BulkGet chunks), the "{}" fallback,
			// a legacy-JSON one, a child, and one with customStatus.
			for _, key := range []string{"order/inst-0000", "billing/inst-0001", "billing/inst-0007", "billing/inst-0013", "order/inst-0006"} {
				appID, id, _ := strings.Cut(key, "/")
				got, err := svc.Get(context.Background(), appID, id)
				require.NoError(t, err, key)
				require.Equal(t, want[key], got, key)
			}
			require.Len(t, want["order/inst-0000"].History, 150)
		})
	}
}
