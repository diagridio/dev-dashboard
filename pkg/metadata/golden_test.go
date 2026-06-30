//go:build integration

package metadata

import (
	"encoding/json"
	"flag"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/internal/golden"
	"github.com/stretchr/testify/require"
)

var update = flag.Bool("update", false, "regenerate golden files")

// TestCatalogSummaryGolden pins the (type,name,version,status) tuples of the
// processed catalog, so an upstream bundle refresh that changes the component
// set or ordering surfaces as a reviewable diff. The full 754 KB bundle is not
// golden'd; only this compact summary.
func TestCatalogSummaryGolden(t *testing.T) {
	require.NoError(t, Init())
	var b Bundle
	require.NoError(t, parseProcessed(&b))

	type row struct {
		Type    string `json:"type"`
		Name    string `json:"name"`
		Version string `json:"version"`
		Status  string `json:"status"`
	}
	summary := make([]row, 0, len(b.Components))
	for _, c := range b.Components {
		summary = append(summary, row{c.Type, c.Name, c.Version, c.Status})
	}
	got, err := json.MarshalIndent(summary, "", "  ")
	require.NoError(t, err)

	golden.Assert(t, *update, filepath.Join("testdata", "catalog-summary.json"), got)
}
