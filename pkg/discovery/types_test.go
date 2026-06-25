//go:build unit

package discovery

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInstanceJSONKeys(t *testing.T) {
	b, err := json.Marshal(Instance{AppID: "x", HTTPPort: 3500, MetadataOK: true})
	require.NoError(t, err)
	s := string(b)
	require.Contains(t, s, `"appId":"x"`)
	require.Contains(t, s, `"httpPort":3500`)
	require.Contains(t, s, `"metadataOk":true`)
}

func TestHealthConstants(t *testing.T) {
	require.Equal(t, Health("unknown"), HealthUnknown)
}
