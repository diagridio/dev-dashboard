package cmd

import (
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// ActorStoreFor answers which registered state store holds an app's actor
// state. It returns the registry entry id (the id StateFor accepts) and the
// component name.
//
// ok=false with a non-empty name means the app loads a state component the
// dashboard has no connection for (or none flagged actorStateStore). The
// reported name is a best guess: sidecar metadata does not carry the
// actorStateStore flag. Both empty means the app loads no state component the
// dashboard can identify.
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
		// Container posture: only the elected store is addressable, and only
		// when it is flagged as the actor state store.
		if active := rc.activeComponent(); active != nil && loaded[active.Name] {
			if active.Metadata["actorStateStore"] == "true" {
				return entryID(SourceAuto, normPath(active.Path)), active.Name, true
			}
			return "", active.Name, false
		}
	} else {
		entries := rc.registry.List()
		det := rc.detectRegistry(entries)

		type candidate struct {
			id, name string
			under    bool
		}
		var actor []candidate
		for _, e := range entries {
			if e.Dismissed || !loaded[e.Name] {
				continue
			}
			connected[e.Name] = true
			comp, _ := rc.componentForEntry(e, det)
			c := candidate{id: e.ID, name: e.Name, under: pathUnder(comp.Path, in.ResourcePaths)}
			if comp.Metadata["actorStateStore"] == "true" {
				actor = append(actor, c)
			}
		}
		// Same-named stores: the one under the app's resource paths wins.
		for _, c := range actor {
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
	// Every loaded name is registered but none is flagged as the actor store.
	names := make([]string, 0, len(loaded))
	for n := range loaded {
		names = append(names, n)
	}
	sort.Strings(names)
	return "", names[0], false
}
