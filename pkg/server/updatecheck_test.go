//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/stretchr/testify/require"
)

type fakeUpdateCheck struct{ r updatecheck.Result }

func (f fakeUpdateCheck) Check(context.Context) updatecheck.Result { return f.r }

func TestUpdateCheckEndpoint(t *testing.T) {
	h := updateCheckRouter(fakeUpdateCheck{r: updatecheck.Result{
		Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true,
		ReleaseURL: "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0",
	}})
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"updateAvailable":true`)
	require.Contains(t, body, `"latest":"v1.3.0"`)
	require.Contains(t, body, `"releaseUrl":"https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0"`)
}
