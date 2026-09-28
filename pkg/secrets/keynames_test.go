//go:build unit

package secrets

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestKeyNamesFileStore(t *testing.T) {
	svc, _ := writeStore(t, fileStoreDefaultYAML,
		`{"zeta":"1","alpha":"2","redis":{"password":"3"}}`)

	names, capped, err := svc.KeyNames(context.Background(), "localsecretstore")
	require.NoError(t, err)
	require.False(t, capped)
	// Sorted, and nested keys appear in their flattened form — which is the
	// form a secretKeyRef must use.
	require.Equal(t, []string{"alpha", "redis:password", "zeta"}, names)
}

func TestKeyNamesCaps(t *testing.T) {
	payload := map[string]string{}
	for i := 0; i < MaxKeyNames+50; i++ {
		payload[fmt.Sprintf("key%04d", i)] = "v"
	}
	blob, err := json.Marshal(payload)
	require.NoError(t, err)

	svc, _ := writeStore(t, fileStoreDefaultYAML, string(blob))
	names, capped, err := svc.KeyNames(context.Background(), "localsecretstore")
	require.NoError(t, err)
	require.True(t, capped)
	require.Len(t, names, MaxKeyNames)
}

func TestKeyNamesEnvStoreRequiresPrefix(t *testing.T) {
	ctx := context.Background()

	// No prefix: listing would dump the whole environment, so refuse.
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
`, "")
	names, _, err := svc.KeyNames(ctx, "envsecrets")
	require.NoError(t, err)
	require.Nil(t, names)

	// With a prefix, only matching names are listed (prefix stripped).
	t.Setenv("MYAPP_ONE", "1")
	svc, _ = writeStore(t, envStoreWithPrefixYAML, "")
	names, _, err = svc.KeyNames(ctx, "envsecrets")
	require.NoError(t, err)
	require.Contains(t, names, "ONE")
}

func TestKeyNamesUnknownStore(t *testing.T) {
	svc, _ := writeStore(t, fileStoreDefaultYAML, `{"a":"b"}`)
	_, _, err := svc.KeyNames(context.Background(), "nope")
	require.Error(t, err)
}
