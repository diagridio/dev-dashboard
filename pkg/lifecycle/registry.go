package lifecycle

import (
	"sort"
	"sync"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// Entry is one stopped (fully or partially) standalone instance.
type Entry struct {
	Instance discovery.Instance
	Procs    map[Target]ProcSnapshot
}

// Registry is the in-memory record of instances the dashboard stopped. It is
// intentionally not persisted: after a dashboard restart the processes are
// genuinely gone and unknowable.
type Registry struct {
	mu      sync.Mutex
	entries map[string]*Entry // keyed by InstanceKey
}

func NewRegistry() *Registry { return &Registry{entries: map[string]*Entry{}} }

// RecordStop merges snaps into the entry for in's InstanceKey, storing in as
// the display snapshot.
func (r *Registry) RecordStop(in discovery.Instance, snaps map[Target]ProcSnapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[in.InstanceKey]
	if !ok {
		e = &Entry{Procs: map[Target]ProcSnapshot{}}
		r.entries[in.InstanceKey] = e
	}
	e.Instance = in
	for t, s := range snaps {
		e.Procs[t] = s
	}
}

// Get resolves key by InstanceKey first, then by AppID (first match, sorted).
func (r *Registry) Get(key string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[key]; ok {
		return e.clone(), true
	}
	for _, k := range r.sortedKeys() {
		if r.entries[k].Instance.AppID == key {
			return r.entries[k].clone(), true
		}
	}
	return Entry{}, false
}

// DropTarget removes one target's snapshot; the entry disappears with its
// last target.
func (r *Registry) DropTarget(key string, t Target) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[key]
	if !ok {
		return
	}
	delete(e.Procs, t)
	if len(e.Procs) == 0 {
		delete(r.entries, key)
	}
}

// Drop removes the whole entry.
func (r *Registry) Drop(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, key)
}

// List returns all entries sorted by InstanceKey.
func (r *Registry) List() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, 0, len(r.entries))
	for _, k := range r.sortedKeys() {
		out = append(out, r.entries[k].clone())
	}
	return out
}

func (r *Registry) sortedKeys() []string {
	keys := make([]string, 0, len(r.entries))
	for k := range r.entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (e *Entry) clone() Entry {
	procs := make(map[Target]ProcSnapshot, len(e.Procs))
	for t, s := range e.Procs {
		procs[t] = s
	}
	return Entry{Instance: e.Instance, Procs: procs}
}
