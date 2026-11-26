package actors

import (
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/state"
)

// ActorID is one actor instance seen in state and/or reminders.
// Sources is a subset of {"state", "reminders"}.
type ActorID struct {
	ID        string   `json:"id"`
	StateKeys int      `json:"stateKeys"`
	Reminders int      `json:"reminders"`
	Sources   []string `json:"sources"`
}

// splitActorKey splits a logical key "type||id||key". The key part may itself
// contain "||", so only the first two separators count.
func splitActorKey(logical string) (typ, id string, ok bool) {
	parts := strings.SplitN(logical, "||", 3)
	if len(parts) != 3 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// IDsFromState returns actor id -> state key count for actorType. The type
// must match exactly.
func IDsFromState(items []state.Item, actorType string) map[string]int {
	out := map[string]int{}
	for _, it := range items {
		if typ, id, ok := splitActorKey(it.LogicalKey); ok && typ == actorType {
			out[id]++
		}
	}
	return out
}

// StateKeysFor returns the items that belong to one actor instance.
func StateKeysFor(items []state.Item, actorType, actorID string) []state.Item {
	out := []state.Item{}
	for _, it := range items {
		if typ, id, ok := splitActorKey(it.LogicalKey); ok && typ == actorType && id == actorID {
			out = append(out, it)
		}
	}
	return out
}

// MergeIDs combines state-derived ids with reminder owners, sorted by ID.
func MergeIDs(fromState map[string]int, reminders []Scheduled) []ActorID {
	byID := map[string]*ActorID{}
	get := func(id string) *ActorID {
		a, ok := byID[id]
		if !ok {
			a = &ActorID{ID: id, Sources: []string{}}
			byID[id] = a
		}
		return a
	}
	for id, n := range fromState {
		a := get(id)
		a.StateKeys = n
		a.Sources = append(a.Sources, "state")
	}
	for _, r := range reminders {
		a := get(r.ActorID)
		if a.Reminders == 0 {
			a.Sources = append(a.Sources, "reminders")
		}
		a.Reminders++
	}
	out := make([]ActorID, 0, len(byID))
	for _, a := range byID {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
