//go:build unit

package resources

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const compYAML = "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.redis\n  version: v1\n"
const cfgYAML = "apiVersion: dapr.io/v1alpha1\nkind: Configuration\nmetadata:\n  name: appconfig\nspec:\n  tracing:\n    samplingRate: \"1\"\n"
const subYAML = "apiVersion: dapr.io/v2alpha1\nkind: Subscription\nmetadata:\n  name: orders-sub\nspec:\n  topic: orders\n  routes:\n    default: /orders\n  pubsubname: pubsub\n"

func TestResourcesListAndGet(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(compYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "appconfig.yaml"), []byte(cfgYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "orders-sub.yaml"), []byte(subYAML), 0o600))
	svc := New(func() []string { return []string{dir} }, nil)

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	require.Equal(t, "statestore", comps[0].Name)
	require.Equal(t, "state.redis", comps[0].Type)
	require.Empty(t, comps[0].Raw) // List does not include raw

	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "appconfig", cfgs[0].Name)

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Contains(t, got.Raw, "state.redis")

	_, err = svc.Get(context.Background(), KindComponent, "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

const comp2YAML = "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: pubsub\nspec:\n  type: pubsub.redis\n  version: v1\n"

func TestResourcesMultiDocFile(t *testing.T) {
	dir := t.TempDir()
	multi := comp2YAML + "---\n" + cfgYAML + "---\n" + compYAML
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resources.yaml"), []byte(multi), 0o600))
	svc := New(func() []string { return []string{dir} }, nil)

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 2)
	require.Equal(t, "pubsub", comps[0].Name)
	require.Equal(t, "pubsub.redis", comps[0].Type)
	require.Equal(t, "statestore", comps[1].Name)
	require.Equal(t, "state.redis", comps[1].Type)

	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "appconfig", cfgs[0].Name)

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Contains(t, got.Raw, "state.redis")
}

func TestResourcesStableIDsAndDuplicateNames(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	// Two components sharing metadata.name "statestore" in different files.
	require.NoError(t, os.WriteFile(filepath.Join(dirA, "statestore.yaml"), []byte(compYAML), 0o600))
	dupYAML := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.sqlite\n  version: v1\n"
	require.NoError(t, os.WriteFile(filepath.Join(dirB, "statestore.yaml"), []byte(dupYAML), 0o600))
	svc := New(func() []string { return []string{dirA, dirB} }, nil)

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 2, "duplicate names must both be listed")
	require.NotEmpty(t, comps[0].ID)
	require.NotEmpty(t, comps[1].ID)
	require.NotEqual(t, comps[0].ID, comps[1].ID, "distinct files get distinct ids")
	require.Len(t, comps[0].ID, 12, "id mirrors the registry's 12-char entryID shape")
	require.Less(t, comps[0].Path, comps[1].Path, "equal names sort by path")

	// IDs are stable across scans.
	again, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Equal(t, comps[0].ID, again[0].ID)

	// Get by ID returns the exact file, even for the name-collision loser.
	got, err := svc.Get(context.Background(), KindComponent, comps[1].ID)
	require.NoError(t, err)
	require.Equal(t, comps[1].Path, got.Path)
	require.Contains(t, got.Raw, "state.sqlite")

	// Get by name still works (first match) for old deep links.
	byName, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Equal(t, comps[0].Path, byName.Path)

	// Unknown id-or-name -> ErrNotFound.
	_, err = svc.Get(context.Background(), KindComponent, "nosuchthing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestExtras_MergedListedAndFetched(t *testing.T) {
	content := []byte("apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: kvstore\nspec:\n  type: state.in-memory\n  version: v1\n  metadata:\n  - name: actorStateStore\n    value: \"true\"\n")
	extras := func() []Resource { return FromRaw("crazy_lamport:/dapr-resources/kvstore.yaml", content) }
	svc := New(func() []string { return nil }, extras)

	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "kvstore", list[0].Name)
	require.Equal(t, "state.in-memory", list[0].Type)
	require.Equal(t, "v1", list[0].Version)
	require.Equal(t, "crazy_lamport:/dapr-resources/kvstore.yaml", list[0].Path)
	require.Empty(t, list[0].Raw, "List strips Raw")

	got, err := svc.Get(context.Background(), KindComponent, list[0].ID)
	require.NoError(t, err)
	require.Contains(t, got.Raw, "actorStateStore")

	// Name-based lookup works too.
	got, err = svc.Get(context.Background(), KindComponent, "kvstore")
	require.NoError(t, err)
	require.Equal(t, list[0].ID, got.ID)
}

func TestExtras_ConfigurationDocRoutedByKind(t *testing.T) {
	content := []byte("kind: Component\nmetadata:\n  name: a\nspec:\n  type: state.in-memory\n---\nkind: Configuration\nmetadata:\n  name: cfg\n")
	extras := func() []Resource { return FromRaw("c1:/res/multi.yaml", content) }
	svc := New(func() []string { return nil }, extras)

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "cfg", cfgs[0].Name)
}

func TestExtras_NilProviderKeepsFileBehavior(t *testing.T) {
	svc := New(func() []string { return nil }, nil)
	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Empty(t, list)
}

const resYAML = `apiVersion: dapr.io/v1alpha1
kind: Resiliency
metadata:
  name: party-api-resiliency
scopes:
  - party-api
spec:
  policies:
    timeouts:
      downstream: 2s
    retries:
      threeTimes:
        policy: constant
        duration: 500ms
        maxRetries: 3
    circuitBreakers:
      registryCB:
        maxRequests: 1
        timeout: 15s
        trip: consecutiveFailures >= 5
  targets:
    apps:
      party-registry:
        timeout: downstream
        retry: threeTimes
        circuitBreaker: registryCB
    components:
      statestore:
        outbound:
          retry: threeTimes
`

func TestResiliencyListAndGet(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(compYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resiliency.yaml"), []byte(resYAML), 0o600))
	svc := New(func() []string { return []string{dir} }, nil)

	list, err := svc.List(context.Background(), KindResiliency)
	require.NoError(t, err)
	require.Len(t, list, 1)
	r := list[0]
	require.Equal(t, "party-api-resiliency", r.Name)
	require.Equal(t, KindResiliency, r.Kind)
	require.Equal(t, filepath.Join(dir, "resiliency.yaml"), r.Path)
	require.Equal(t, []string{"party-api"}, r.Scopes)
	require.Empty(t, r.Raw)

	require.NotNil(t, r.Resiliency)
	p := r.Resiliency.Policies
	require.Equal(t, map[string]string{"downstream": "2s"}, p.Timeouts)
	require.Equal(t, "constant", p.Retries["threeTimes"]["policy"])
	require.EqualValues(t, 3, p.Retries["threeTimes"]["maxRetries"])
	require.Equal(t, "consecutiveFailures >= 5", p.CircuitBreakers["registryCB"]["trip"])
	require.Equal(t, ResiliencyPolicyRefs{Timeout: "downstream", Retry: "threeTimes", CircuitBreaker: "registryCB"},
		r.Resiliency.Targets.Apps["party-registry"])
	require.Equal(t, &ResiliencyPolicyRefs{Retry: "threeTimes"}, r.Resiliency.Targets.Components["statestore"].Outbound)
	require.Nil(t, r.Resiliency.Targets.Components["statestore"].Inbound)

	// Resiliency docs do not leak into the other kinds.
	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	require.Nil(t, comps[0].Resiliency)

	got, err := svc.Get(context.Background(), KindResiliency, r.ID)
	require.NoError(t, err)
	require.Contains(t, got.Raw, "consecutiveFailures")
	require.NotNil(t, got.Resiliency)
}

func TestResiliencyMalformedSpecStillListed(t *testing.T) {
	dir := t.TempDir()
	bad := "apiVersion: dapr.io/v1alpha1\nkind: Resiliency\nmetadata:\n  name: odd\nspec:\n  policies: [not, a, map]\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "odd.yaml"), []byte(bad), 0o600))
	svc := New(func() []string { return []string{dir} }, nil)

	list, err := svc.List(context.Background(), KindResiliency)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "odd", list[0].Name)
	require.Nil(t, list[0].Resiliency)
}

func TestExtras_ResiliencyDoc(t *testing.T) {
	extras := func() []Resource { return FromRaw("c1:/res/resiliency.yaml", []byte(resYAML)) }
	svc := New(func() []string { return nil }, extras)

	list, err := svc.List(context.Background(), KindResiliency)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Empty(t, list[0].Raw)
	require.Equal(t, []string{"party-api"}, list[0].Scopes)
	require.NotNil(t, list[0].Resiliency)
}
