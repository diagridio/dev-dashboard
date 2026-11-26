package cmd

import (
	"log/slog"
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// ActorStoreFor answers which registered state store holds an app's actor
// state. It returns the registry entry id (the id StateFor accepts) and the
// component name.
//
// ok=false with a non-empty name means the app loads a state component the
// dashboard has no connection for. Both empty means the app loads no state
// component at all.
func (rc *reconciler) ActorStoreFor(in discovery.Instance) (string, string, bool) {
	loaded := map[string]bool{}
	for _, c := range in.Components {
		if strings.HasPrefix(c.Type, "state.") {
			loaded[c.Name] = true
		}
	}
	if len(loaded) == 0 {
		return "", "", false
	}

	connected := map[string]bool{}
	var id, name string
	var found, underWon bool

	if rc.registry == nil {
		// Container posture: only the elected store is addressable.
		if active := rc.activeComponent(); active != nil && loaded[active.Name] {
			return entryID(SourceAuto, normPath(active.Path)), active.Name, true
		}
	} else {
		entries := rc.registry.List()
		var autoPaths []string
		seen := map[string]bool{}
		for _, e := range entries {
			if e.Source != SourceManual && !e.Dismissed && !seen[e.Path] {
				seen[e.Path] = true
				autoPaths = append(autoPaths, e.Path)
			}
		}
		var det *autoDetection
		if len(autoPaths) > 0 {
			det = detectAuto(autoPaths, slog.Default().With("component", "reconciler"))
		}

		type candidate struct {
			id, name string
			under    bool
		}
		var actor, anyLoaded []candidate
		for _, e := range entries {
			if e.Dismissed || !loaded[e.Name] {
				continue
			}
			connected[e.Name] = true
			comp, _ := rc.componentForEntry(e, det)
			c := candidate{id: e.ID, name: e.Name, under: pathUnder(comp.Path, in.ResourcePaths)}
			anyLoaded = append(anyLoaded, c)
			if comp.Metadata["actorStateStore"] == "true" {
				actor = append(actor, c)
			}
		}
		pool := actor
		if len(pool) == 0 && len(anyLoaded) == 1 {
			// No store is flagged as the actor store; a single loaded match is unambiguous.
			pool = anyLoaded
		}
		// Same-named stores: the one under the app's resource paths wins.
		for _, c := range pool {
			if !found || (c.under && !underWon) {
				id, name, found, underWon = c.id, c.name, true, c.under
			}
		}
		if found {
			return id, name, true
		}
	}

	// The app loads state components but none resolved to a connection: report
	// the first loaded name without one so the caller can say what is missing.
	var missing []string
	for n := range loaded {
		if !connected[n] {
			missing = append(missing, n)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		return "", missing[0], false
	}
	return "", "", false
}
