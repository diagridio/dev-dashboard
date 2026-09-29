//go:build unit

package cmd

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// fakeSecretsService is a minimal secrets.Service double so
// resolveComponentSecrets can be tested without touching the filesystem or
// components-contrib.
type fakeSecretsService struct {
	resolve func(ctx context.Context, storeName string, ref secrets.Ref) secrets.Result
}

func (f fakeSecretsService) Stores(context.Context) []secrets.Store { return nil }

func (f fakeSecretsService) Resolve(ctx context.Context, storeName string, ref secrets.Ref) secrets.Result {
	return f.resolve(ctx, storeName, ref)
}

func (f fakeSecretsService) KeyNames(context.Context, string) ([]string, bool, error) {
	return nil, false, nil
}

// Path 1: a component with no SecretRefs passes its metadata through
// unchanged, and never calls Resolve.
func TestResolveComponentSecrets_NoRefsPassthrough(t *testing.T) {
	svc := fakeSecretsService{resolve: func(context.Context, string, secrets.Ref) secrets.Result {
		t.Fatal("Resolve must not be called when the component has no secret refs")
		return secrets.Result{}
	}}
	c := statestore.Component{
		Name:     "s",
		Metadata: map[string]string{"host": "localhost:6379"},
	}
	out, issue := resolveComponentSecrets(svc, c)
	require.Equal(t, map[string]string{"host": "localhost:6379"}, out)
	require.Empty(t, issue)
}

// Path 2: a secretKeyRef that resolves successfully has its value applied
// into the returned metadata map, alongside untouched inline metadata.
func TestResolveComponentSecrets_ResolvedValueApplied(t *testing.T) {
	svc := fakeSecretsService{resolve: func(_ context.Context, storeName string, ref secrets.Ref) secrets.Result {
		require.Equal(t, "local-secrets", storeName)
		require.Equal(t, "secretKeyRef", ref.Kind)
		require.Equal(t, "redis-secret", ref.Name)
		require.Equal(t, "password", ref.Key)
		return secrets.Result{Status: secrets.StatusResolved, Value: "s3cr3t"}
	}}
	c := statestore.Component{
		Name:        "s",
		Metadata:    map[string]string{"host": "localhost:6379"},
		SecretStore: "local-secrets",
		SecretRefs: map[string]statestore.SecretRef{
			"redisPassword": {Name: "redis-secret", Key: "password"},
		},
	}
	out, issue := resolveComponentSecrets(svc, c)
	require.Equal(t, "s3cr3t", out["redisPassword"])
	require.Equal(t, "localhost:6379", out["host"])
	require.Empty(t, issue)
}

// TestResolveComponentSecrets_EnvRefKindPassedThrough covers finding 2: the
// reconciler used to hardcode Kind: "secretKeyRef" when calling Resolve, so
// even a correctly-detected envRef would be resolved as a secretKeyRef
// against the wrong store logic. It must now forward the ref's actual kind.
func TestResolveComponentSecrets_EnvRefKindPassedThrough(t *testing.T) {
	svc := fakeSecretsService{resolve: func(_ context.Context, storeName string, ref secrets.Ref) secrets.Result {
		require.Equal(t, "envRef", ref.Kind)
		require.Equal(t, "REDIS_PASSWORD", ref.Name)
		return secrets.Result{Status: secrets.StatusResolved, Value: "s3cr3t"}
	}}
	c := statestore.Component{
		Name:     "s",
		Metadata: map[string]string{"host": "localhost:6379"},
		SecretRefs: map[string]statestore.SecretRef{
			"redisPassword": {Kind: "envRef", Name: "REDIS_PASSWORD"},
		},
	}
	out, issue := resolveComponentSecrets(svc, c)
	require.Equal(t, "s3cr3t", out["redisPassword"])
	require.Empty(t, issue)
}

// TestResolveComponentSecrets_EnvRefUnresolvedProducesIssue verifies that an
// envRef which fails to resolve (variable unset) surfaces a real SecretIssue
// naming the field — previously it never reached this path at all because
// pkg/statestore/detect.go dropped envRef entries silently.
func TestResolveComponentSecrets_EnvRefUnresolvedProducesIssue(t *testing.T) {
	svc := fakeSecretsService{resolve: func(_ context.Context, _ string, ref secrets.Ref) secrets.Result {
		return secrets.Result{Status: secrets.StatusEmptyValue, Detail: "env var " + ref.Name}
	}}
	c := statestore.Component{
		Name: "s",
		SecretRefs: map[string]statestore.SecretRef{
			"redisPassword": {Kind: "envRef", Name: "REDIS_PASSWORD"},
		},
	}
	out, issue := resolveComponentSecrets(svc, c)
	require.Empty(t, out["redisPassword"])
	require.Contains(t, issue, "redisPassword unresolved")
	require.Contains(t, issue, "REDIS_PASSWORD")
}

// Path 3: with multiple unresolved fields, the reported issue always names
// the same (sorted-first) field, deterministically across repeated calls —
// map iteration order must never leak into the diagnostic.
func TestResolveComponentSecrets_MultipleUnresolvedIsDeterministic(t *testing.T) {
	svc := fakeSecretsService{resolve: func(_ context.Context, _ string, ref secrets.Ref) secrets.Result {
		return secrets.Result{Status: secrets.StatusKeyNotFound, Detail: "no such key: " + ref.Name}
	}}
	c := statestore.Component{
		Name:        "s",
		SecretStore: "local-secrets",
		SecretRefs: map[string]statestore.SecretRef{
			"zField": {Name: "z-secret"},
			"aField": {Name: "a-secret"},
			"mField": {Name: "m-secret"},
		},
	}
	for i := 0; i < 20; i++ {
		out, issue := resolveComponentSecrets(svc, c)
		require.Contains(t, issue, "aField unresolved",
			"the issue must always name the alphabetically-first field, not whichever the map iterated to first")
		require.Empty(t, out["zField"])
		require.Empty(t, out["aField"])
		require.Empty(t, out["mField"])
	}
}
