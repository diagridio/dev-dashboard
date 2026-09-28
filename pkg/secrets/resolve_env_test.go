//go:build unit

package secrets

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

const envStoreWithPrefixYAML = `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
  metadata:
  - name: prefix
    value: MYAPP_
`

func TestResolveEnvStoreAppliesPrefix(t *testing.T) {
	t.Setenv("MYAPP_REDIS_PASSWORD", "from-env")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	// The ref names the secret WITHOUT the prefix; contrib prepends it.
	got := svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "REDIS_PASSWORD"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "from-env", got.Value)
	require.Contains(t, got.Detail, "MYAPP_REDIS_PASSWORD")
}

// TestResolveEnvStoreUnsetVsEmpty: contrib's local.env GetSecret uses
// os.Getenv, which cannot tell an unset variable from one set to "". The
// resolver must, because the fixes differ: export the variable vs give it a
// value. Both details must say whose environment was read, since the
// dashboard sees its own process environment, not daprd's.
func TestResolveEnvStoreUnsetVsEmpty(t *testing.T) {
	t.Setenv("MYAPP_BLANK", "")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	got := svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "NOT_SET"})
	require.Equal(t, StatusKeyNotFound, got.Status)
	require.Contains(t, got.Detail, "MYAPP_NOT_SET")
	require.Contains(t, got.Detail, "not set")
	require.Contains(t, got.Detail, "dashboard's environment")

	got = svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "BLANK"})
	require.Equal(t, StatusEmptyValue, got.Status)
	require.Contains(t, got.Detail, "MYAPP_BLANK")
	require.Contains(t, got.Detail, "dashboard's environment")

	// local.env returns a single key equal to the secret name, so a
	// mismatched key is still not found even when the variable is set.
	t.Setenv("MYAPP_SET", "v")
	got = svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "SET", Key: "OTHER"})
	require.Equal(t, StatusKeyNotFound, got.Status)
}

// TestResolveEnvStoreDenylist covers finding 4 of the whole-branch review:
// contrib's local/env store never errors on a denied key — GetSecret just
// returns an empty value — so a naive resolver would report StatusEmptyValue
// for DAPR_SECRET, sending the user hunting for an unset variable that Dapr
// will never read regardless of its value. The pre-check must catch this
// before calling GetSecret and report StatusForbidden instead.
func TestResolveEnvStoreDenylist(t *testing.T) {
	t.Setenv("DAPR_SECRET", "nope")
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
`, "")
	got := svc.Resolve(context.Background(), "envsecrets", Ref{Kind: "secretKeyRef", Name: "DAPR_SECRET"})
	require.Equal(t, StatusForbidden, got.Status, "DAPR_* must be reported forbidden, not empty-value")
	require.Contains(t, got.Detail, "DAPR_SECRET")
}

// TestResolveEnvStoreDenylistAppliesPrefix verifies the denylist check is
// applied to the prefix-qualified name, mirroring contrib's own
// GetSecret (name := prefix + req.Name; isKeyAllowed(name)) — a ref whose
// bare name looks harmless can still resolve to a denied full env var name
// once the store's prefix is applied.
func TestResolveEnvStoreDenylistAppliesPrefix(t *testing.T) {
	t.Setenv("DAPR_API_TOKEN", "nope")
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
  metadata:
  - name: prefix
    value: DAPR_
`, "")
	got := svc.Resolve(context.Background(), "envsecrets", Ref{Kind: "secretKeyRef", Name: "API_TOKEN"})
	require.Equal(t, StatusForbidden, got.Status)
}

// TestResolveEnvStoreDoesNotApplySpaceRule pins the "important subtlety" from
// finding 4: contrib's local/env isKeyAllowed only denies APP_API_TOKEN and
// DAPR_-prefixed names — no space rule, unlike EnvVarAllowed (the runtime's
// envRef path). Resolving via secretKeyRef against a local.env store must
// use contrib's own rule, not EnvVarAllowed, or this would over-deny a key
// contrib would happily read.
func TestResolveEnvStoreDoesNotApplySpaceRule(t *testing.T) {
	t.Setenv("HAS SPACE", "value")
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
`, "")
	got := svc.Resolve(context.Background(), "envsecrets", Ref{Kind: "secretKeyRef", Name: "HAS SPACE"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "value", got.Value)
}

func TestResolveEnvRef(t *testing.T) {
	t.Setenv("MY_TOKEN", "tok")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	// envRef bypasses the secret store entirely: no prefix, no store lookup.
	got := svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "MY_TOKEN"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "tok", got.Value)
	require.Contains(t, got.Detail, "MY_TOKEN")

	got = svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "UNSET_VAR"})
	require.Equal(t, StatusKeyNotFound, got.Status)
	require.Contains(t, got.Detail, "not set")
	require.Contains(t, got.Detail, "dashboard's environment")

	t.Setenv("BLANK_VAR", "")
	got = svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "BLANK_VAR"})
	require.Equal(t, StatusEmptyValue, got.Status)
	require.Contains(t, got.Detail, "dashboard's environment")
}

func TestEnvVarAllowed(t *testing.T) {
	require.True(t, EnvVarAllowed("MY_TOKEN"))
	require.False(t, EnvVarAllowed(""))
	require.False(t, EnvVarAllowed("APP_API_TOKEN"))
	require.False(t, EnvVarAllowed("app_api_token"), "the check is case-insensitive")
	require.False(t, EnvVarAllowed("DAPR_API_TOKEN"))
	require.False(t, EnvVarAllowed("has space"))
}

func TestResolveEnvRefForbidden(t *testing.T) {
	t.Setenv("DAPR_API_TOKEN", "nope")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	got := svc.Resolve(context.Background(), "", Ref{Kind: "envRef", Name: "DAPR_API_TOKEN"})
	require.Equal(t, StatusForbidden, got.Status)
	require.Empty(t, got.Value)
}

func TestEnvKeysAllowlist(t *testing.T) {
	// DAPR_ENV_KEYS is injector-set and Kubernetes-only, but Dapr honours it,
	// so mirroring it keeps behaviour identical wherever it happens to be set.
	t.Setenv("DAPR_ENV_KEYS", "ALLOWED_ONE ALLOWED_TWO")
	require.True(t, EnvVarAllowed("ALLOWED_ONE"))
	require.True(t, EnvVarAllowed("ALLOWED_TWO"))
	require.False(t, EnvVarAllowed("OTHER"))
	require.True(t, EnvVarAllowed("allowed_one"), "allowlist matching is case-insensitive, as in Dapr")
}

// TestResolveMarksEnvDependentOutcomes: FromEnv flags exactly the outcomes
// that depend on what the dashboard's own process environment contains, so
// the component view can decline to show them (daprd's environment may
// differ). Config-level outcomes such as the denylist or a key that can never
// match stay unflagged.
func TestResolveMarksEnvDependentOutcomes(t *testing.T) {
	t.Setenv("MYAPP_SET", "v")
	t.Setenv("MYAPP_BLANK", "")
	t.Setenv("PLAIN_SET", "v")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	for _, ref := range []Ref{
		{Kind: "secretKeyRef", Name: "SET"},
		{Kind: "secretKeyRef", Name: "BLANK"},
		{Kind: "secretKeyRef", Name: "NOT_SET"},
	} {
		require.True(t, svc.Resolve(ctx, "envsecrets", ref).FromEnv, ref.Name)
	}
	require.True(t, svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "PLAIN_SET"}).FromEnv)
	require.True(t, svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "UNSET_VAR"}).FromEnv)

	require.False(t, svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "SET", Key: "OTHER"}).FromEnv,
		"a key that differs from the name never matches, whatever the environment holds")
	require.False(t, svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "DAPR_API_TOKEN"}).FromEnv)
	require.False(t, svc.Resolve(ctx, "missing", Ref{Kind: "secretKeyRef", Name: "SET"}).FromEnv)
}
