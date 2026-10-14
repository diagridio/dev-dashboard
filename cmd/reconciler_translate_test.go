//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// In compose container posture the dashboard shares the compose network, so
// an in-network store address must reach the pool untouched. Host posture
// rewrites it to localhost:<published>, which would be wrong here. The guard
// is composeEnv == nil, which container posture gets by never constructing a
// ComposeSource — this test pins that behavior against a future refactor.
func TestTranslateIsNoOpWithoutComposeEnv(t *testing.T) {
	rc := &reconciler{composeEnv: nil}
	in := statestore.Component{
		Name: "statestore",
		Path: "/components/statestore.yaml",
		Metadata: map[string]string{
			"redisHost": "redis:6379",
		},
	}

	got := rc.translate(in)

	if got.Metadata["redisHost"] != "redis:6379" {
		t.Fatalf("in-network address was rewritten: got %q want %q",
			got.Metadata["redisHost"], "redis:6379")
	}
}
