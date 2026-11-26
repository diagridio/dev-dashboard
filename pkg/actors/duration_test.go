//go:build unit

package actors

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCompactDuration(t *testing.T) {
	cases := map[string]string{
		"0h30m0s0ms":     "30m",
		"24h0m0s0ms":     "24h",
		"1h30m0s":        "1h30m",
		"0h1m30s0ms":     "1m30s",
		"1.5s":           "1.5s",
		"90s":            "1m30s",
		"@every 24h0m0s": "@every 24h0m0s",
		"PT30M":          "PT30M",
		"":               "",
		"0h0m0s0ms":      "0s",
	}
	for in, want := range cases {
		assert.Equal(t, want, compactDuration(in), in)
	}
}

func TestForTypeCompactsIdleTimeout(t *testing.T) {
	cfg := AppConfig{ActorIdleTimeout: "0h30m0s0ms"}
	assert.Equal(t, TypeConfig{IdleTimeout: "30m"}, cfg.ForType("X"))
}
