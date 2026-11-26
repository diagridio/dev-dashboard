//go:build unit

package actors

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/state"
	"github.com/stretchr/testify/require"
)

func items(keys ...string) []state.Item {
	out := make([]state.Item, 0, len(keys))
	for _, k := range keys {
		out = append(out, state.Item{LogicalKey: k})
	}
	return out
}

func TestIDsFromState(t *testing.T) {
	got := IDsFromState(items("Deck||d1||a", "Deck||d1||b", "Deck||d2||a", "DeckX||d9||a", "XDeck||d8||a", "Deck||||k"), "Deck")
	require.Equal(t, map[string]int{"d1": 2, "d2": 1}, got)
}

func TestStateKeysFor(t *testing.T) {
	in := items("Deck||d1||a", "Deck||d1||b", "Deck||d2||a", "DeckX||d1||a")
	got := StateKeysFor(in, "Deck", "d1")
	require.Equal(t, items("Deck||d1||a", "Deck||d1||b"), got)
}

func TestMergeIDs(t *testing.T) {
	got := MergeIDs(map[string]int{"d1": 2, "": 1}, []Scheduled{{ActorID: "d1"}, {ActorID: "d3"}, {ActorID: ""}})
	require.Equal(t, []ActorID{
		{ID: "d1", StateKeys: 2, Reminders: 1, Sources: []string{"state", "reminders"}},
		{ID: "d3", StateKeys: 0, Reminders: 1, Sources: []string{"reminders"}},
	}, got)
}
