# Connection Registry + Lazy Multi-Connection Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every detected and manually-added state store to a user-profile registry file and lazily connect to any of them on demand, so workflow data in a store whose app has stopped (or that the user switched away from) stays viewable.

**Architecture:** Three focused units behind the existing extended `server.StoreRegistry` / `server.WorkflowBackend` interfaces: a `registry` that owns the `~/.dapr/dev-dashboard/connections.yaml` file (load/save, auto-persist discovered stores as path refs, CRUD for manual entries); a `connpool` lazy connection cache keyed by store identity (`name|type|ConnInfo`) with per-identity single-flight and retention-until-shutdown; and the existing `reconciler` rewired to hold both — auto-persisting detected stores and pre-warming the elected active store through the pool instead of owning a single connection with close-old/open-new logic.

**Tech Stack:** Go, `sigs.k8s.io/yaml` (v1.5.0, round-trips Windows backslash paths), `github.com/go-chi/chi/v5`, `github.com/stretchr/testify/require`, `golang.org/x/sync/singleflight` is NOT used — single-flight is hand-rolled per-identity with a `sync.Mutex` + per-key channel to keep the open outside the map lock.

## Global Constraints

- Build tags: new Go test files start with `//go:build unit` (unit) or `//go:build integration`. Unit run: `go test -tags unit -race ./...`; integration run: `go test -tags integration ./cmd/...`. Bare `go test` finds no tests in `cmd`/`pkg/statestore`.
- Commit ONLY each task's files via explicit `git add <paths>`; never `git commit -am`. Leave pre-existing uncommitted artifacts `web/dist/index.html` + `web/package-lock.json` untouched.
- Registry file path: `filepath.Join(homeDir, ".dapr", "dev-dashboard", "connections.yaml")`, perms `0600`, via the `sigs.k8s.io/yaml` marshaler (round-trips Windows backslash paths). Never hand-format.
- Auto entries dedup by normalized absolute path (`filepath.Clean`), case-insensitive on Windows; manual entries keyed by name. Auto-persist never overwrites a manual entry.
- connpool keyed by identity `name|type|ConnInfo`; per-identity single-flight; open outside the lock; retains connections (does NOT close on active-store change); `Close()` closes all.
- Supported types only: `state.redis`, `state.sqlite`, `state.postgresql` (POST/PUT validate). Secrets-free `ConnInfo` only in API responses; registry file `0600`; server binds `127.0.0.1`.

**Known limitation (intentional for 2b):** auto entries dedup by path (so two projects that both name their store `statestore` are both *persisted*), but the API/`ServiceFor`/`DELETE` address stores by **name** — so on a name collision, `componentFor`/`Delete` act on the first matching entry. Same-name cross-project stores are therefore stored but not independently selectable. Addressing by a stable id (instead of name) is a future enhancement, deferred to avoid rippling an id through the API and 2c. Single-store and distinct-name (e.g. redis→postgres) switches — the primary use case — are unaffected.

---

### Task 1: Connection registry file (entry model + persistence + CRUD)

**Files:**
- Create: `cmd/registry.go`
- Test: `cmd/registry_test.go`

**Interfaces:**
- Consumes: nothing (leaf task). Uses `sigs.k8s.io/yaml`, `os`, `path/filepath`, `runtime`, `sync`.
- Produces (relied on by Tasks 2–5, exact names/signatures):
  - `type ConnEntry struct { Name string; Type string; Source string; Path string; Metadata map[string]string }` with yaml tags `name,type,source,path,metadata`. `Source` is `"auto"` or `"manual"`.
  - `const SourceAuto = "auto"`, `const SourceManual = "manual"`.
  - `type ConnRegistry struct { ... }` (unexported fields: `path string`, `mu sync.Mutex`, `entries []ConnEntry`).
  - `func registryPath(homeDir string) string` → `filepath.Join(homeDir, ".dapr", "dev-dashboard", "connections.yaml")`.
  - `func LoadRegistry(homeDir string) *ConnRegistry` — never returns nil; a missing or malformed file yields an empty registry (logged).
  - `func (r *ConnRegistry) List() []ConnEntry` — returns a copy, stable order (entries slice order).
  - `func (r *ConnRegistry) UpsertAuto(e ConnEntry) error` — keyed by normalized path; never overwrites a `manual` entry at the same path; persists.
  - `func (r *ConnRegistry) Add(e ConnEntry) error` — manual add keyed by name; errors if a manual entry with that name exists; persists.
  - `func (r *ConnRegistry) Update(e ConnEntry) error` — manual update keyed by name; errors if no manual entry with that name exists; persists.
  - `func (r *ConnRegistry) Delete(name string) error` — deletes any entry (manual or auto) by name; persists; no error if absent.
  - `func (r *ConnRegistry) save() error` — marshals via `sigs.k8s.io/yaml`, writes `0600`, creating the parent dir `0700`.

- [ ] **Step 1: Write the failing test**

Create `cmd/registry_test.go`:

```go
//go:build unit

package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRegistry_SaveLoadRoundTrip_WindowsPath(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)

	// A backslash Windows-style path must round-trip through the YAML marshaler.
	winPath := `C:\Users\dev\Resources\statestore.yaml`
	require.NoError(t, r.UpsertAuto(ConnEntry{
		Name: "statestore", Type: "state.redis", Source: SourceAuto, Path: winPath,
	}))
	require.NoError(t, r.Add(ConnEntry{
		Name: "my-pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=localhost dbname=orders user=u password=p"},
	}))

	// The file exists with 0600 perms.
	fi, err := os.Stat(registryPath(home))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), fi.Mode().Perm())

	// Reload from disk and assert both entries survived verbatim.
	r2 := LoadRegistry(home)
	got := r2.List()
	require.Len(t, got, 2)

	byName := map[string]ConnEntry{}
	for _, e := range got {
		byName[e.Name] = e
	}
	require.Equal(t, winPath, byName["statestore"].Path, "backslash path must round-trip")
	require.Equal(t, SourceAuto, byName["statestore"].Source)
	require.Equal(t, "host=localhost dbname=orders user=u password=p", byName["my-pg"].Metadata["connectionString"])
	require.Equal(t, SourceManual, byName["my-pg"].Source)
}

func TestRegistry_UpsertAutoDedupsByNormalizedPath(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)

	// Two upserts whose paths differ only by ./ and trailing slashes normalize equal.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Source: SourceAuto, Path: "/a/b/statestore.yaml"}))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s2", Type: "state.sqlite", Source: SourceAuto, Path: "/a/./b/statestore.yaml"}))

	got := r.List()
	require.Len(t, got, 1, "same normalized path must dedup")
	// The second upsert refreshes name/type.
	require.Equal(t, "s2", got[0].Name)
	require.Equal(t, "state.sqlite", got[0].Type)
}

func TestRegistry_UpsertAutoNeverOverwritesManual(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)

	// Manual entry whose Path collides with a soon-to-be-detected auto path.
	require.NoError(t, r.Add(ConnEntry{Name: "manual", Type: "state.redis", Source: SourceManual, Path: "/a/store.yaml"}))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "auto", Type: "state.sqlite", Source: SourceAuto, Path: "/a/store.yaml"}))

	got := r.List()
	require.Len(t, got, 1, "auto-persist must not add a second entry over a manual at the same path")
	require.Equal(t, "manual", got[0].Name)
	require.Equal(t, SourceManual, got[0].Source)
}

func TestRegistry_ManualAddEditDelete(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)

	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=a"}}))
	// Duplicate add errors.
	require.Error(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql", Source: SourceManual}))

	// Update an existing manual entry.
	require.NoError(t, r.Update(ConnEntry{Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=b"}}))
	require.Equal(t, "host=b", r.List()[0].Metadata["connectionString"])

	// Update a missing manual entry errors.
	require.Error(t, r.Update(ConnEntry{Name: "nope", Type: "state.redis", Source: SourceManual}))

	// Delete works and persists.
	require.NoError(t, r.Delete("pg"))
	require.Len(t, r.List(), 0)
	require.NoError(t, r.Delete("pg"), "deleting an absent entry is not an error")

	// Persistence survives reload.
	require.Len(t, LoadRegistry(home).List(), 0)
}

func TestRegistry_MalformedFileYieldsEmpty(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".dapr", "dev-dashboard")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "connections.yaml"), []byte("{{ not yaml ::::"), 0o600))

	r := LoadRegistry(home)
	require.Len(t, r.List(), 0, "malformed file must yield an empty registry, not a crash")

	// And the registry is still usable (a save overwrites the bad file).
	require.NoError(t, r.Add(ConnEntry{Name: "x", Type: "state.redis", Source: SourceManual}))
	require.Len(t, LoadRegistry(home).List(), 1)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./cmd/ -run TestRegistry`
Expected: FAIL — compile error `undefined: LoadRegistry` / `undefined: ConnEntry` (the symbols don't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `cmd/registry.go`:

```go
package cmd

import (
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"sigs.k8s.io/yaml"
)

// Source values for a ConnEntry.
const (
	SourceAuto   = "auto"
	SourceManual = "manual"
)

// ConnEntry is one persisted connection in the registry file.
// auto entries carry a Path (re-read + 2a-resolved on connect, no secrets in
// the file); manual entries carry inline Metadata (possibly secrets).
type ConnEntry struct {
	Name     string            `json:"name"`
	Type     string            `json:"type"`
	Source   string            `json:"source"`
	Path     string            `json:"path,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// connFile is the on-disk shape of the registry file.
type connFile struct {
	Connections []ConnEntry `json:"connections"`
}

// ConnRegistry owns the user-profile connections.yaml file. All mutators
// persist under a mutex; List returns a copy.
type ConnRegistry struct {
	path    string
	mu      sync.Mutex
	entries []ConnEntry
}

// registryPath is the canonical connections.yaml path under the home dir.
func registryPath(homeDir string) string {
	return filepath.Join(homeDir, ".dapr", "dev-dashboard", "connections.yaml")
}

// LoadRegistry reads the registry file. A missing or malformed file yields an
// empty (but usable) registry; it never returns nil and never crashes.
func LoadRegistry(homeDir string) *ConnRegistry {
	r := &ConnRegistry{path: registryPath(homeDir)}
	data, err := os.ReadFile(r.path)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Default().With("component", "registry").Warn("read registry file failed; starting empty", "path", r.path, "err", err)
		}
		return r
	}
	var f connFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		slog.Default().With("component", "registry").Warn("malformed registry file; starting empty", "path", r.path, "err", err)
		return r
	}
	r.entries = f.Connections
	return r
}

// normPath returns a comparison key for an auto entry's path: cleaned, and
// lower-cased on Windows where the filesystem is case-insensitive.
func normPath(p string) string {
	c := filepath.Clean(p)
	if runtime.GOOS == "windows" {
		return strings.ToLower(c)
	}
	return c
}

// List returns a copy of the current entries in stable order.
func (r *ConnRegistry) List() []ConnEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ConnEntry, len(r.entries))
	copy(out, r.entries)
	return out
}

// UpsertAuto inserts or refreshes an auto entry keyed by normalized path.
// It never overwrites a manual entry sharing the same normalized path.
func (r *ConnRegistry) UpsertAuto(e ConnEntry) error {
	e.Source = SourceAuto
	r.mu.Lock()
	defer r.mu.Unlock()
	key := normPath(e.Path)
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && normPath(r.entries[i].Path) == key && key != normPath("") {
			return nil // never overwrite a manual entry
		}
	}
	for i := range r.entries {
		if r.entries[i].Source == SourceAuto && normPath(r.entries[i].Path) == key {
			r.entries[i].Name = e.Name
			r.entries[i].Type = e.Type
			r.entries[i].Path = e.Path
			r.entries[i].Metadata = e.Metadata
			return r.save()
		}
	}
	r.entries = append(r.entries, e)
	return r.save()
}

// Add inserts a manual entry keyed by name; errors if a manual entry with that
// name already exists.
func (r *ConnRegistry) Add(e ConnEntry) error {
	e.Source = SourceManual
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && r.entries[i].Name == e.Name {
			return os.ErrExist
		}
	}
	r.entries = append(r.entries, e)
	return r.save()
}

// Update replaces a manual entry keyed by name; errors if none exists.
func (r *ConnRegistry) Update(e ConnEntry) error {
	e.Source = SourceManual
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && r.entries[i].Name == e.Name {
			r.entries[i] = e
			return r.save()
		}
	}
	return os.ErrNotExist
}

// Delete removes any entry (manual or auto) by name. Absent name is a no-op.
func (r *ConnRegistry) Delete(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.entries[:0]
	removed := false
	for _, e := range r.entries {
		if e.Name == name {
			removed = true
			continue
		}
		out = append(out, e)
	}
	r.entries = out
	if !removed {
		return nil
	}
	return r.save()
}

// save marshals the registry and writes it 0600 (parent dir 0700). Caller holds mu.
func (r *ConnRegistry) save() error {
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	data, err := yaml.Marshal(connFile{Connections: r.entries})
	if err != nil {
		return err
	}
	return os.WriteFile(r.path, data, 0o600)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit -race ./cmd/ -run TestRegistry`
Expected: PASS (all five `TestRegistry_*` subtests).

- [ ] **Step 5: Commit**

```bash
git add cmd/registry.go cmd/registry_test.go
git commit -m "feat(cmd): add connection registry file (entry model, persistence, CRUD)"
```

---

### Task 2: buildStoreEntry helper + lazy connection pool

**Files:**
- Modify: `cmd/workflow.go` (add `buildStoreEntry` helper; leave `storeBackend`/`newStoreBackend` in place — retired in Task 3)
- Create: `cmd/connpool.go`
- Test: `cmd/connpool_test.go`

**Interfaces:**
- Consumes from Task 1: nothing directly (the pool takes already-built `statestore.Component` values).
- Consumes existing code: `storeOpener` (`func(context.Context, statestore.Component) (statestore.Store, error)`, `cmd/workflow.go:22`), `storeEntry` (`cmd/workflow.go:147`), `newTargetResolver` (`cmd/workflow.go:113`), `workflow.New(store, namespace)` (`pkg/workflow/service.go:41`), `workflow.NewRemover(client, store, namespace)` (`pkg/workflow/remove.go:36`), `statestore.New` (`pkg/statestore/store.go:59`), `identity(*statestore.Component) string` (`cmd/reconciler.go:66`).
- Produces (relied on by Task 3):
  - `func buildStoreEntry(st statestore.Store, namespace string, client *http.Client, apps discovery.Service) storeEntry` — constructs `workflow.Service` + `WorkflowRemover` + `targetResolver` for an already-opened store.
  - `type connPool struct { ... }`.
  - `func newConnPool(namespace string, client *http.Client, apps discovery.Service, open storeOpener) *connPool` — `open == nil` defaults to `statestore.New`.
  - `func (p *connPool) openOrGet(ctx context.Context, c statestore.Component) (storeEntry, error)` — identity-keyed (`identity(&c)`), per-identity single-flight, caches on success, opens outside the map lock.
  - `func (p *connPool) evict(c statestore.Component)` — closes + removes one identity's cached connection (used by DELETE in Task 4).
  - `func (p *connPool) Close() error` — closes every cached connection.

- [ ] **Step 1: Write the failing test**

Create `cmd/connpool_test.go`:

```go
//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// countingStore is a fake statestore.Store that records Close calls.
type countingStore struct {
	closes *int32
}

func (s countingStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", nil
}
func (s countingStore) Get(context.Context, string) ([]byte, error)              { return nil, nil }
func (s countingStore) BulkGet(context.Context, []string) (map[string][]byte, error) { return nil, nil }
func (s countingStore) Delete(context.Context, string) error                     { return nil }
func (s countingStore) Set(context.Context, string, []byte) error                { return nil }
func (s countingStore) Close() error                                             { atomic.AddInt32(s.closes, 1); return nil }

// fakeOpener counts opens and hands back countingStores. If block is non-nil it
// waits on it before returning (to probe single-flight).
type fakeOpener struct {
	opens  int32
	closes int32
	block  chan struct{}
	err    error
}

func (o *fakeOpener) open(_ context.Context, _ statestore.Component) (statestore.Store, error) {
	atomic.AddInt32(&o.opens, 1)
	if o.block != nil {
		<-o.block
	}
	if o.err != nil {
		return nil, o.err
	}
	return countingStore{closes: &o.closes}, nil
}

func compA() statestore.Component {
	return statestore.Component{Name: "A", Type: "state.sqlite", Metadata: map[string]string{"connectionString": "a.db"}}
}
func compB() statestore.Component {
	return statestore.Component{Name: "B", Type: "state.sqlite", Metadata: map[string]string{"connectionString": "b.db"}}
}

func TestConnPool_OpensOnceAndCaches(t *testing.T) {
	o := &fakeOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	e1, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	require.NotNil(t, e1.svc)

	e2, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	require.NotNil(t, e2.svc)

	require.Equal(t, int32(1), atomic.LoadInt32(&o.opens), "same identity must open exactly once")
}

func TestConnPool_OpenError_NotCached(t *testing.T) {
	o := &fakeOpener{err: errors.New("connect failed")}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.Error(t, err)
	_, err = p.openOrGet(context.Background(), compA())
	require.Error(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(&o.opens), "a failed open is not cached; it retries")
}

func TestConnPool_SingleFlight(t *testing.T) {
	o := &fakeOpener{block: make(chan struct{})}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	const n = 8
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_, _ = p.openOrGet(context.Background(), compA())
		}()
	}
	// Give the goroutines time to all arrive at the single-flight gate, then release.
	// We can't sleep (blocked by harness); instead release immediately — the
	// per-identity gate still funnels concurrent callers through one open.
	close(o.block)
	wg.Wait()

	require.Equal(t, int32(1), atomic.LoadInt32(&o.opens), "concurrent opens of one identity must open once")
}

func TestConnPool_CloseClosesAll(t *testing.T) {
	o := &fakeOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	_, err = p.openOrGet(context.Background(), compB())
	require.NoError(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(&o.opens))

	require.NoError(t, p.Close())
	require.Equal(t, int32(2), atomic.LoadInt32(&o.closes), "Close must close every cached connection")
}

func TestConnPool_TwoIdentitiesBothRetained(t *testing.T) {
	o := &fakeOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	_, err = p.openOrGet(context.Background(), compB())
	require.NoError(t, err)

	// No close happens just because a second identity was opened (retention).
	require.Equal(t, int32(0), atomic.LoadInt32(&o.closes), "opening a second store must NOT close the first")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./cmd/ -run TestConnPool`
Expected: FAIL — compile error `undefined: newConnPool` (and `buildStoreEntry` not yet referenced; the pool symbols don't exist).

- [ ] **Step 3: Write minimal implementation**

First add `buildStoreEntry` to `cmd/workflow.go`. Insert it immediately after the `newStoreBackend` function (after `cmd/workflow.go:236`, the closing `}` of `newStoreBackend`):

```go

// buildStoreEntry assembles the per-store workflow service, remover, and target
// resolver for an already-opened state store. It is the construction the old
// newStoreBackend did inline; the connpool reuses it for each opened identity.
func buildStoreEntry(st statestore.Store, namespace string, client *http.Client, apps discovery.Service) storeEntry {
	svc := workflow.New(st, namespace)
	rem := workflow.NewRemover(client, st, namespace)
	res := newTargetResolver(apps, svc)
	return storeEntry{svc: svc, rem: rem, targets: res}
}
```

Now create `cmd/connpool.go`:

```go
package cmd

import (
	"context"
	"net/http"
	"sync"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// poolSlot is one cached identity. Its done channel implements per-identity
// single-flight: concurrent openOrGet callers for the same identity find the
// slot, then wait on done; the first caller runs the open outside the map lock.
type poolSlot struct {
	done  chan struct{}
	entry storeEntry
	store statestore.Store
	err   error
}

// connPool is a lazy, identity-keyed connection cache. It opens a store on first
// use, caches it for the session, and closes everything on Close. It never
// closes a connection just because the active store changed (retention).
type connPool struct {
	namespace string
	client    *http.Client
	apps      discovery.Service
	open      storeOpener

	mu     sync.Mutex
	slots  map[string]*poolSlot
	closed bool
}

// newConnPool builds a connPool. open == nil defaults to statestore.New.
func newConnPool(namespace string, client *http.Client, apps discovery.Service, open storeOpener) *connPool {
	if open == nil {
		open = statestore.New
	}
	return &connPool{
		namespace: namespace,
		client:    client,
		apps:      apps,
		open:      open,
		slots:     make(map[string]*poolSlot),
	}
}

// openOrGet returns the cached entry for c's identity, or opens it once. The
// open runs outside the map lock; concurrent callers for the same identity
// funnel through one open (per-identity single-flight). A failed open is not
// cached: the slot is removed so the next caller retries.
func (p *connPool) openOrGet(ctx context.Context, c statestore.Component) (storeEntry, error) {
	id := identity(&c)

	p.mu.Lock()
	if slot, ok := p.slots[id]; ok {
		p.mu.Unlock()
		<-slot.done
		return slot.entry, slot.err
	}
	slot := &poolSlot{done: make(chan struct{})}
	p.slots[id] = slot
	p.mu.Unlock()

	st, err := p.open(ctx, c)
	if err != nil {
		// Don't cache failures: drop the slot so a later select retries.
		p.mu.Lock()
		delete(p.slots, id)
		p.mu.Unlock()
		slot.err = err
		close(slot.done)
		return storeEntry{}, err
	}

	slot.store = st
	slot.entry = buildStoreEntry(st, p.namespace, p.client, p.apps)
	close(slot.done)
	return slot.entry, nil
}

// evict closes and removes the cached connection for c's identity, if present.
func (p *connPool) evict(c statestore.Component) {
	id := identity(&c)
	p.mu.Lock()
	slot, ok := p.slots[id]
	if ok {
		delete(p.slots, id)
	}
	p.mu.Unlock()
	if ok && slot.store != nil {
		_ = slot.store.Close()
	}
}

// Close closes every cached connection and prevents further caching.
func (p *connPool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	slots := p.slots
	p.slots = make(map[string]*poolSlot)
	p.mu.Unlock()

	var err error
	for _, slot := range slots {
		<-slot.done
		if slot.store != nil {
			if e := slot.store.Close(); e != nil {
				err = e
			}
		}
	}
	return err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit -race ./cmd/ -run 'TestConnPool|TestStoreBackend|TestStoreRegistry|TestTargetResolver'`
Expected: PASS — all `TestConnPool_*` pass and the pre-existing `cmd` unit tests still pass (the `buildStoreEntry` addition is additive).

- [ ] **Step 5: Commit**

```bash
git add cmd/workflow.go cmd/connpool.go cmd/connpool_test.go
git commit -m "feat(cmd): extract buildStoreEntry; add lazy identity-keyed connpool"
```

---

### Task 3: Rewire the reconciler onto the registry + connpool

**Files:**
- Modify: `cmd/reconciler.go` (replace `storeBackend`/`closers`/`activeIdentity` machinery with `registry` + `connpool`)
- Modify: `cmd/workflow.go` (remove `storeBackend`, `newStoreBackend`, and the `var _ server.WorkflowBackend = (*storeBackend)(nil)` assertion — now retired)
- Modify: `cmd/serve.go` (load the registry from `HomeDir`, build the connpool, pass them into the reconciler)
- Modify: `cmd/workflow_test.go` (remove tests that reference the retired `storeBackend`/`newStoreBackend`; keep `newStoreRegistry` tests)
- Test: `cmd/reconciler_test.go` (new — ServiceFor routing)

**Interfaces:**
- Consumes from Task 1: `LoadRegistry`, `*ConnRegistry`, `ConnEntry`, `SourceAuto`, `SourceManual`, `(*ConnRegistry).List/UpsertAuto/Add/Update/Delete`.
- Consumes from Task 2: `newConnPool`, `(*connPool).openOrGet/evict/Close`, `buildStoreEntry`.
- Consumes existing: `newStoreRegistry` + `(*storeRegistry).active()` (active election, `cmd/workflow.go:45`/`:81`), `derivePaths` (`cmd/derive.go:21`), `statestore.Detect/DetectSecretStores/ResolveSecrets`, `statestore.Component`, `workflow.New(nil, ns)` + `workflow.NewRemover(client, nil, ns)` (degraded entry).
- Produces (relied on by Task 4 + Task 5):
  - `reconciler` struct now holds `registry *ConnRegistry`, `pool *connPool`, `electedReg *storeRegistry` (replacing `backend`/`closers`/`activeIdentity`), and `degraded storeEntry`.
  - `func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client, registry *ConnRegistry, pool *connPool) *reconciler` — NEW signature (adds registry + pool).
  - `(*reconciler).activeComponent() *statestore.Component` — the elected active component under the read lock (used by Stores()).
  - `(*reconciler).componentFor(name string) (statestore.Component, bool)` — resolve a registry entry name to a built `statestore.Component` (auto: Detect+resolve at path; manual: inline metadata). Used by ServiceFor and (Task 4) DELETE eviction.
  - `ServiceFor`, `Stores`, `Paths`, `fingerprint`, `maybeReconcile`, `Close` keep their existing signatures.

- [ ] **Step 1: Write the failing test**

Create `cmd/reconciler_test.go`:

```go
//go:build unit

package cmd

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// seedAutoComponentYAML writes a minimal sqlite component YAML and returns its abs path.
func seedAutoComponentYAML(t *testing.T, dir, name, db string) string {
	t.Helper()
	y := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: " + name +
		"\nspec:\n  type: state.sqlite\n  version: v1\n  metadata:\n  - name: connectionString\n    value: " + db + "\n"
	p := filepath.Join(dir, name+".yaml")
	require.NoError(t, os.WriteFile(p, []byte(y), 0o644))
	abs, err := filepath.Abs(p)
	require.NoError(t, err)
	return abs
}

func TestReconciler_ServiceForRouting(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	// An auto entry referencing a real component YAML on disk.
	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))
	require.NoError(t, reg.Add(ConnEntry{Name: "manualstore", Type: "state.sqlite", Source: SourceManual,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "manual.db")}}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Seed an elected active store directly (no apps needed for this routing test).
	active := statestore.Component{Name: "active", Type: "state.sqlite", Metadata: map[string]string{"connectionString": filepath.Join(dir, "active.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil)
	rc.mu.Unlock()

	t.Run("empty name -> active (pre-warmed via pool)", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("")
		require.True(t, ok)
	})
	t.Run("named auto entry resolves and connects", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("autostore")
		require.True(t, ok)
	})
	t.Run("named manual entry resolves and connects", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("manualstore")
		require.True(t, ok)
	})
	t.Run("unknown name -> ok=false", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("nosuchstore")
		require.False(t, ok)
	})

	require.GreaterOrEqual(t, o.opens, int32(1), "the fake opener must have been used for named lookups")
}

func TestReconciler_NoActiveNoStoresDegraded(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// No elected store and empty name -> degraded entry, ok=true.
	_, _, _, ok := rc.ServiceFor("")
	require.True(t, ok, "empty name with no active store returns the degraded entry")
}
```

Then, **delete** the now-obsolete tests in `cmd/workflow_test.go` that reference the retired `storeBackend`/`newStoreBackend` symbols. Remove these functions and the `buildTestBackend` helper:
`buildTestBackend`, `TestStoreBackend_EmptyNameReturnsActive`, `TestStoreBackend_KnownNameReturnsEntry`, `TestStoreBackend_UnknownNameReturnsFalse`, `TestStoreBackend_NoStoresDegraded`, `TestStoreBackend_NoStoresUnknownExplicit`, `TestNewStoreBackend_LogsNoStoreDetected`, `TestNewStoreBackend_RegistersOnlyActiveStore` (lines `171`–`310` of the file as read). Also drop the now-unused imports `"context"`, `"net/http"`, and `"strings"` from `cmd/workflow_test.go` if no remaining test uses them (the `targetResolver` and `storeRegistry` tests still use `context`; `net/http` and `strings` become unused once the storeBackend tests go — remove those two). Keep `TestTargetResolver`, all `TestStoreRegistry_*`, and `TestNewRootCmd_NewFlags`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./cmd/ -run 'TestReconciler'`
Expected: FAIL — compile error: `newReconciler` is called with 7 args but the current signature takes 5 (`too many arguments`), and `rc.electedReg` / `o.opens` field access on a reconciler without those fields (`undefined: rc.electedReg`).

- [ ] **Step 3: Write minimal implementation**

Rewrite `cmd/reconciler.go` in full:

```go
package cmd

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// Compile-time interface assertions.
var _ server.StoreRegistry = (*reconciler)(nil)
var _ server.WorkflowBackend = (*reconciler)(nil)

// connectTimeout bounds a single state-store connection attempt during reconcile.
const connectTimeout = 15 * time.Second

// reconciler owns the apps-derived state: resource scan paths, the active-store
// election, the persisted connection registry, and the lazy connection pool. It
// re-derives this state when the apps fingerprint changes: auto-persisting each
// detected store to the registry and pre-warming the elected active store
// through the pool. It no longer owns a single connection or closers — the pool
// retains connections for the session.
type reconciler struct {
	// immutable after construction
	apps           discovery.Service
	namespace      string
	homeDir        string
	stateStorePath string
	client         *http.Client
	open           storeOpener
	registry       *ConnRegistry
	pool           *connPool
	degraded       storeEntry

	reconciling atomic.Bool // single-flight guard for background reconciles

	mu         sync.RWMutex
	fp         string
	resPaths   []string
	electedReg *storeRegistry // last election (for active() + the active flag)
	closed     bool
}

// newReconciler builds a reconciler. open defaults to statestore.New; tests
// override it via the exported field after construction. The registry and pool
// are injected (the pool already carries the opener used for connections).
func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client, registry *ConnRegistry, pool *connPool) *reconciler {
	return &reconciler{
		apps:           apps,
		namespace:      namespace,
		homeDir:        homeDir,
		stateStorePath: stateStorePath,
		client:         client,
		open:           statestore.New,
		registry:       registry,
		pool:           pool,
		degraded:       buildStoreEntry(nil, namespace, client, apps),
	}
}

// identity returns a secrets-free key for connection identity.
func identity(c *statestore.Component) string {
	if c == nil {
		return ""
	}
	return c.Name + "|" + c.Type + "|" + statestore.ConnInfo(*c)
}

// reconcile is NOT safe for concurrent use: callers MUST ensure only one
// reconcile runs at a time (the reconcilingApps decorator's single-flight guard
// and the synchronous boot seed are the only callers). It re-derives state from
// apps: detect + resolve stores, auto-persist them to the registry, elect the
// active store, and pre-warm it through the pool. fp is the precomputed
// fingerprint for apps.
func (rc *reconciler) reconcile(apps []discovery.Instance, fp string) {
	log := slog.Default().With("component", "reconciler")
	resPaths, scanPaths, loaded := derivePaths(apps, rc.homeDir, rc.stateStorePath)
	detected, _ := statestore.Detect(scanPaths)
	secretStores, _ := statestore.DetectSecretStores(scanPaths)
	for i := range detected {
		resolved, unresolved := statestore.ResolveSecrets(detected[i], secretStores)
		detected[i].Metadata = resolved
		if len(unresolved) > 0 {
			log.Warn("unresolved secretKeyRef metadata", "store", detected[i].Name, "keys", unresolved)
		}
		// Auto-persist every detected store as a path-ref. Persist the YAML path,
		// not the resolved metadata, so no secrets land in the registry file.
		if rc.registry != nil {
			if err := rc.registry.UpsertAuto(ConnEntry{
				Name: detected[i].Name, Type: detected[i].Type, Source: SourceAuto, Path: detected[i].Path,
			}); err != nil {
				log.Warn("auto-persist store failed", "store", detected[i].Name, "err", err)
			}
		}
	}

	newReg := newStoreRegistry(detected, loaded)

	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return
	}
	rc.resPaths, rc.electedReg, rc.fp = resPaths, newReg, fp
	rc.mu.Unlock()

	// Pre-warm the elected active store through the pool. The pool retains it;
	// it is never closed when the active store later changes.
	if active := newReg.active(); active != nil && rc.pool != nil {
		octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		if _, err := rc.pool.openOrGet(octx, *active); err != nil {
			log.Warn("pre-warm active store failed", "store", active.Name, "err", err)
		}
	}
	log.Info("reconciled derived state", "activeStore", identity(newReg.active()), "detected", len(detected))
}

// activeComponent returns the elected active component, or nil if none.
func (rc *reconciler) activeComponent() *statestore.Component {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	if rc.electedReg == nil {
		return nil
	}
	return rc.electedReg.active()
}

// componentFor resolves a registry entry name to a built statestore.Component.
// auto entries are re-read from their YAML path and 2a-resolved; manual entries
// use their inline metadata. ok=false means no registry entry by that name.
func (rc *reconciler) componentFor(name string) (statestore.Component, bool) {
	if rc.registry == nil {
		return statestore.Component{}, false
	}
	for _, e := range rc.registry.List() {
		if e.Name != name {
			continue
		}
		switch e.Source {
		case SourceManual:
			return statestore.Component{Name: e.Name, Type: e.Type, Metadata: e.Metadata}, true
		default: // auto
			detected, _ := statestore.Detect([]string{e.Path})
			for i := range detected {
				if detected[i].Path == e.Path || detected[i].Name == e.Name {
					secretStores, _ := statestore.DetectSecretStores([]string{e.Path})
					resolved, _ := statestore.ResolveSecrets(detected[i], secretStores)
					detected[i].Metadata = resolved
					return detected[i], true
				}
			}
			// YAML missing/unreadable: return a bare component (connect will error).
			return statestore.Component{Name: e.Name, Type: e.Type, Path: e.Path}, true
		}
	}
	return statestore.Component{}, false
}

// Stores satisfies server.StoreRegistry. Reconciler-level implementation lands
// in Task 4 (all registry entries with Source + active flag). This base version
// returns the elected active store only; Task 4 replaces it.
func (rc *reconciler) Stores() []server.StoreInfo {
	active := rc.activeComponent()
	if active == nil {
		return []server.StoreInfo{}
	}
	return []server.StoreInfo{{
		Name:       active.Name,
		Type:       active.Type,
		Path:       active.Path,
		Active:     true,
		Connection: statestore.ConnInfo(*active),
	}}
}

// ServiceFor satisfies server.WorkflowBackend.
//   - name == "" -> the elected active store, pre-warmed via the pool; if no
//     store is elected, the degraded entry (ok=true).
//   - name matches a registry entry -> build its component, connect via the pool.
//   - unknown name -> ok=false.
func (rc *reconciler) ServiceFor(name string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	if name == "" {
		active := rc.activeComponent()
		if active == nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		e, err := rc.pool.openOrGet(octx, *active)
		if err != nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		return e.svc, e.rem, e.targets, true
	}

	comp, ok := rc.componentFor(name)
	if !ok {
		return nil, nil, nil, false
	}
	octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		// Known store, unreachable: surface a working-but-empty degraded entry so
		// the API returns a graceful error from the workflow service, not 404.
		return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
	}
	return e.svc, e.rem, e.targets, true
}

// Paths returns the current resource scan paths (provider for resources.New).
func (rc *reconciler) Paths() []string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	out := make([]string, len(rc.resPaths))
	copy(out, rc.resPaths)
	return out
}

// fingerprint returns the last reconciled apps fingerprint.
func (rc *reconciler) fingerprint() string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.fp
}

// maybeReconcile schedules a background reconcile when the apps fingerprint has
// changed and no reconcile is already in flight (single-flight). It never blocks
// the caller and never opens connections on the caller's goroutine.
func (rc *reconciler) maybeReconcile(apps []discovery.Instance) {
	fp := appsFingerprint(apps)
	if fp == rc.fingerprint() {
		return
	}
	if !rc.reconciling.CompareAndSwap(false, true) {
		return // a reconcile is already running; the next poll will catch up
	}
	go func() {
		defer rc.reconciling.Store(false)
		rc.reconcile(apps, fp)
	}()
}

// Close closes the connection pool and prevents further reconciles.
func (rc *reconciler) Close() error {
	rc.mu.Lock()
	rc.closed = true
	rc.mu.Unlock()
	if rc.pool != nil {
		return rc.pool.Close()
	}
	return nil
}

// reconcilingApps decorates a discovery.Service so every List fires a
// fingerprint-gated, single-flight reconcile. Get is a pass-through; the
// frontend polls List, which is sufficient to drive reconciliation.
type reconcilingApps struct {
	inner discovery.Service
	rc    *reconciler
}

func (d reconcilingApps) List(ctx context.Context) ([]discovery.Instance, error) {
	apps, err := d.inner.List(ctx)
	if err == nil {
		d.rc.maybeReconcile(apps)
	}
	return apps, err
}

func (d reconcilingApps) Get(ctx context.Context, appID string) (discovery.Instance, error) {
	return d.inner.Get(ctx, appID)
}
```

Now retire the dead `storeBackend` code in `cmd/workflow.go`. Delete the assertion line `cmd/workflow.go:18`:

```go
var _ server.WorkflowBackend = (*storeBackend)(nil)
```

and delete the entire `storeBackend` type + its `ServiceFor` method + `newStoreBackend` function (`cmd/workflow.go:153`–`236`, from the `// storeBackend implements...` comment through the closing `}` of `newStoreBackend`). Keep `buildStoreEntry` (added in Task 2). After deletion, `cmd/workflow.go` no longer uses `log/slog` — remove that import. The `storeEntry` type, `storeOpener`, `storeRegistry`, `targetResolver`, `newTargetResolver`, and `newStoreRegistry` all remain.

Now update `cmd/serve.go`. Replace the reconciler construction block (`cmd/serve.go:30`–`43`) so it loads the registry and builds the pool:

```go
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Load the persisted connection registry and build the lazy connection pool.
	registry := LoadRegistry(deps.HomeDir)
	pool := newConnPool(deps.Namespace, deps.HTTPClient, appsSvc, nil)

	// Build the reconciler that owns all apps-derived state (resource paths,
	// detected state stores, active-store election) plus the registry and pool.
	rc := newReconciler(appsSvc, deps.Namespace, deps.HomeDir, deps.StateStorePath, deps.HTTPClient, registry, pool)

	// Seed once synchronously from the boot snapshot so the first request is
	// correct. Best-effort: an empty/failed list yields an empty derived state.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}
	rc.reconcile(apps, appsFingerprint(apps))
```

(The remainder of `assembleOptions` — `decorated`, `newsSvc`, the returned `server.Options` and `[]func() error{rc.Close}` — is unchanged. `rc.Close` now closes the pool.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit -race ./cmd/... && go build ./...`
Expected: PASS — `TestReconciler_*`, `TestConnPool_*`, the surviving `TestStoreRegistry_*`/`TestTargetResolver`/`TestNewRootCmd_NewFlags` all pass; `go build` succeeds (the retired `storeBackend` has no remaining references).

- [ ] **Step 5: Commit**

```bash
git add cmd/reconciler.go cmd/workflow.go cmd/serve.go cmd/workflow_test.go cmd/reconciler_test.go
git commit -m "refactor(cmd): rewire reconciler onto registry + lazy connpool; retire storeBackend"
```

---

### Task 4: Extend server interfaces + POST/PUT/DELETE statestore routes

**Files:**
- Modify: `pkg/server/workflows.go` (add `Source` to `StoreInfo`; add mutators to `StoreRegistry`)
- Modify: `pkg/server/api.go` (POST/PUT/DELETE `/statestores` routes with validation)
- Modify: `cmd/reconciler.go` (implement the new mutators; rewrite `Stores()` to return ALL registry entries)
- Test: `pkg/server/statestores_test.go` (new — handler validation + DELETE)
- Test: `cmd/reconciler_test.go` (extend — Stores() lists all entries; mutators delegate)

**Interfaces:**
- Consumes from Task 1: `ConnEntry`, `(*ConnRegistry).List/Add/Update/Delete`, `SourceAuto`, `SourceManual`.
- Consumes from Task 3: `(*reconciler).activeComponent`, `(*reconciler).componentFor`, `(*reconciler).registry`, `(*reconciler).pool`, `(*connPool).evict`.
- Produces (relied on by Task 5 + the frontend in 2c):
  - `StoreInfo` gains `Source string \`json:"source"\``.
  - `StoreRegistry` interface gains exactly:
    ```go
    AddStore(name, typ string, metadata map[string]string) error
    UpdateStore(name, typ string, metadata map[string]string) error
    DeleteStore(name string) error
    ```
  - `var ErrUnsupportedStoreType = errors.New("unsupported state store type")` and `var ErrStoreValidation = errors.New("invalid store request")` in `pkg/server` for handler→status mapping.
  - Reconciler implements `AddStore`/`UpdateStore`/`DeleteStore` (delegating to the registry; `DeleteStore` also evicts the pooled connection) and `Stores()` returns ALL registry entries with `Source` set and the elected active store flagged `Active:true`.

- [ ] **Step 1: Write the failing test**

Create `pkg/server/statestores_test.go`:

```go
//go:build unit

package server

import (
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

// mutableStoreRegistry is a StoreRegistry double recording mutator calls.
type mutableStoreRegistry struct {
	stores    []StoreInfo
	added     []StoreInfo
	updated   []StoreInfo
	deleted   []string
	addErr    error
	updateErr error
	deleteErr error
}

func (m *mutableStoreRegistry) Stores() []StoreInfo { return m.stores }

func (m *mutableStoreRegistry) AddStore(name, typ string, metadata map[string]string) error {
	if m.addErr != nil {
		return m.addErr
	}
	m.added = append(m.added, StoreInfo{Name: name, Type: typ, Source: "manual"})
	return nil
}

func (m *mutableStoreRegistry) UpdateStore(name, typ string, metadata map[string]string) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	m.updated = append(m.updated, StoreInfo{Name: name, Type: typ, Source: "manual"})
	return nil
}

func (m *mutableStoreRegistry) DeleteStore(name string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.deleted = append(m.deleted, name)
	return nil
}

func newAPI(stores StoreRegistry) http.Handler {
	return apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), stores, fakeResources{}, fakeNews{})
}

func TestStateStores_PostValidType(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=a"}}`)
	require.Equal(t, http.StatusCreated, res.StatusCode)
	require.Len(t, reg.added, 1)
	require.Equal(t, "pg", reg.added[0].Name)
}

func TestStateStores_PostUnsupportedType(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores", `{"name":"x","type":"state.mongodb","metadata":{}}`)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
	require.Len(t, reg.added, 0)
}

func TestStateStores_PostMissingName(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores", `{"name":"","type":"state.redis","metadata":{}}`)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestStateStores_Delete(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	req, _ := http.NewRequest(http.MethodDelete, "/statestores/old", nil)
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusNoContent, res.StatusCode)
	require.Equal(t, []string{"old"}, reg.deleted)
}

func TestStateStores_PutUpdates(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	req, body := putJSON(t, h, "/statestores/pg",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=b"}}`)
	require.Equal(t, http.StatusOK, req.StatusCode, body)
	require.Len(t, reg.updated, 1)
}
```

Add these helpers to the same file (mirroring `postJSON`):

```go
import (
	"io"
	"net/http/httptest"
	"strings"
)

func doReq(t *testing.T, h http.Handler, req *http.Request) (*http.Response, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func putJSON(t *testing.T, h http.Handler, path, body string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return doReq(t, h, req)
}
```

Then extend `cmd/reconciler_test.go` with a Stores()/mutators test:

```go
func TestReconciler_StoresListsAllEntriesAndMutators(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Elect "autostore" active so the active flag is exercised.
	active := statestore.Component{Name: "autostore", Type: "state.sqlite", Path: autoPath,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "auto.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil)
	rc.mu.Unlock()

	// AddStore -> a manual entry appears in Stores().
	require.NoError(t, rc.AddStore("manualpg", "state.postgresql", map[string]string{"connectionString": "host=h dbname=d"}))

	infos := rc.Stores()
	byName := map[string]server.StoreInfo{}
	for _, i := range infos {
		byName[i.Name] = i
	}
	require.Contains(t, byName, "autostore")
	require.Contains(t, byName, "manualpg")
	require.Equal(t, "auto", byName["autostore"].Source)
	require.True(t, byName["autostore"].Active, "the elected store is flagged active")
	require.Equal(t, "manual", byName["manualpg"].Source)
	require.False(t, byName["manualpg"].Active)
	require.Equal(t, "h/d", byName["manualpg"].Connection, "manual pg connection is secrets-free ConnInfo")

	// UpdateStore mutates the manual entry.
	require.NoError(t, rc.UpdateStore("manualpg", "state.postgresql", map[string]string{"connectionString": "host=h2 dbname=d2"}))
	for _, i := range rc.Stores() {
		if i.Name == "manualpg" {
			require.Equal(t, "h2/d2", i.Connection)
		}
	}

	// DeleteStore removes it.
	require.NoError(t, rc.DeleteStore("manualpg"))
	for _, i := range rc.Stores() {
		require.NotEqual(t, "manualpg", i.Name)
	}
}
```

Add the `"github.com/diagridio/dev-dashboard/pkg/server"` import to `cmd/reconciler_test.go` (the existing imports there are `context`, `net/http`, `os`, `path/filepath`, `testing`, `statestore`, `require`; add `server`).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./pkg/server/ ./cmd/ -run 'StateStores|Reconciler_StoresListsAll'`
Expected: FAIL — `pkg/server`: compile error `mutableStoreRegistry does not implement StoreRegistry` is NOT yet raised (interface lacks mutators) but `apiRouter` returns 405 for POST/PUT/DELETE (routes don't exist) and `StoreInfo` has no `Source` field → `unknown field Source`. `cmd`: `rc.AddStore undefined`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/workflows.go`, add `Source` to `StoreInfo` and extend `StoreRegistry`:

```go
// StoreRegistry exposes the persisted connection registry to the API: listing
// all entries and adding/updating/deleting manual connections.
type StoreRegistry interface {
	Stores() []StoreInfo
	AddStore(name, typ string, metadata map[string]string) error
	UpdateStore(name, typ string, metadata map[string]string) error
	DeleteStore(name string) error
}

// StoreInfo describes one registry connection.
type StoreInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Source     string `json:"source"` // "auto" | "manual"
	Path       string `json:"path"`
	Active     bool   `json:"active"`
	Connection string `json:"connection"` // secrets-free host/db summary for display
}
```

In `pkg/server/api.go`, replace the `/statestores` GET-only handler with full CRUD. Add `errors` to the import block, define the sentinel errors, a `storeBody` type, and the routes. Replace lines `23`–`29` (the `r.Get("/statestores", ...)` block) with:

```go
	r.Route("/statestores", func(sr chi.Router) {
		sr.Get("/", func(w http.ResponseWriter, _ *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusOK, []StoreInfo{})
				return
			}
			writeJSON(w, http.StatusOK, stores.Stores())
		})
		sr.Post("/", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			var body storeBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			if err := validateStoreBody(body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := stores.AddStore(body.Name, body.Type, body.Metadata); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, map[string]string{"name": body.Name})
		})
		sr.Put("/{name}", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			name := chi.URLParam(req, "name")
			var body storeBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			body.Name = name
			if err := validateStoreBody(body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := stores.UpdateStore(name, body.Type, body.Metadata); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"name": name})
		})
		sr.Delete("/{name}", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			if err := stores.DeleteStore(chi.URLParam(req, "name")); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	})
```

Add to `pkg/server/api.go` (after `writeJSON`, and add `"errors"` + `"fmt"` to imports):

```go
// ErrUnsupportedStoreType / ErrStoreValidation map validation failures to 400.
var (
	ErrUnsupportedStoreType = errors.New("unsupported state store type")
	ErrStoreValidation      = errors.New("invalid store request")
)

// storeBody is the POST/PUT request body for a manual connection.
type storeBody struct {
	Name     string            `json:"name"`
	Type     string            `json:"type"`
	Metadata map[string]string `json:"metadata"`
}

// supportedStoreTypes is the closed set the registry accepts for manual entries.
var supportedStoreTypes = map[string]bool{
	"state.redis":      true,
	"state.sqlite":     true,
	"state.postgresql": true,
}

// validateStoreBody enforces required fields and the supported-type allowlist.
func validateStoreBody(b storeBody) error {
	if b.Name == "" {
		return fmt.Errorf("%w: name is required", ErrStoreValidation)
	}
	if !supportedStoreTypes[b.Type] {
		return fmt.Errorf("%w: %s", ErrUnsupportedStoreType, b.Type)
	}
	if len(b.Metadata) == 0 {
		return fmt.Errorf("%w: metadata is required", ErrStoreValidation)
	}
	return nil
}
```

Now implement the mutators on the reconciler and rewrite `Stores()`. In `cmd/reconciler.go`, replace the `Stores()` method written in Task 3 with:

```go
// Stores satisfies server.StoreRegistry. It returns ALL registry entries (auto
// ∪ manual) with Source set and the elected active store flagged. The list
// opens NO DB connections: for each entry it builds the component (auto: read +
// resolve its YAML; manual: inline metadata) and computes the secrets-free
// ConnInfo — a file read, never a connect. A missing YAML yields an empty
// Connection (unreachable), not an error.
func (rc *reconciler) Stores() []server.StoreInfo {
	if rc.registry == nil {
		return []server.StoreInfo{}
	}
	activeID := identity(rc.activeComponent())
	entries := rc.registry.List()
	out := make([]server.StoreInfo, 0, len(entries))
	for _, e := range entries {
		comp, _ := rc.componentFor(e.Name)
		out = append(out, server.StoreInfo{
			Name:       e.Name,
			Type:       e.Type,
			Source:     e.Source,
			Path:       e.Path,
			Active:     identity(&comp) == activeID && activeID != "",
			Connection: statestore.ConnInfo(comp),
		})
	}
	return out
}

// AddStore satisfies server.StoreRegistry: adds a manual connection.
func (rc *reconciler) AddStore(name, typ string, metadata map[string]string) error {
	if rc.registry == nil {
		return nil
	}
	return rc.registry.Add(ConnEntry{Name: name, Type: typ, Source: SourceManual, Metadata: metadata})
}

// UpdateStore satisfies server.StoreRegistry: edits a manual connection and
// evicts any pooled connection so the next select reconnects with new metadata.
func (rc *reconciler) UpdateStore(name, typ string, metadata map[string]string) error {
	if rc.registry == nil {
		return nil
	}
	if err := rc.registry.Update(ConnEntry{Name: name, Type: typ, Source: SourceManual, Metadata: metadata}); err != nil {
		return err
	}
	if comp, ok := rc.componentFor(name); ok && rc.pool != nil {
		rc.pool.evict(comp)
	}
	return nil
}

// DeleteStore satisfies server.StoreRegistry: removes any entry and evicts its
// pooled connection if open.
func (rc *reconciler) DeleteStore(name string) error {
	if rc.registry == nil {
		return nil
	}
	comp, ok := rc.componentFor(name)
	if err := rc.registry.Delete(name); err != nil {
		return err
	}
	if ok && rc.pool != nil {
		rc.pool.evict(comp)
	}
	return nil
}
```

Update the `cmd/serve_integration_test.go` is NOT touched here. Note: the `fakeStoreRegistry` in `pkg/server/workflows_test.go` (lines `213`–`218`) now fails to satisfy the extended interface. Add the three mutators to it:

```go
func (f fakeStoreRegistry) AddStore(string, string, map[string]string) error { return nil }
func (f fakeStoreRegistry) UpdateStore(string, string, map[string]string) error { return nil }
func (f fakeStoreRegistry) DeleteStore(string) error { return nil }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit -race ./pkg/server/ ./cmd/... && go build ./...`
Expected: PASS — all `TestStateStores_*`, the extended `TestReconciler_StoresListsAllEntriesAndMutators`, and the pre-existing server/cmd unit tests (incl. `TestStateStoresEndpoint`, which now also sees a `source` field but still matches its `Contains` assertions) pass; `go build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/workflows.go pkg/server/api.go pkg/server/statestores_test.go cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(server): registry mutators + POST/PUT/DELETE statestores; reconciler lists all entries"
```

---

### Task 5: Integration test — auto + manual stores through the lazy pool

**Files:**
- Create: `cmd/connection_registry_integration_test.go`

**Interfaces:**
- Consumes from Tasks 1–4: the full wired server via `assembleOptions` (auto-detects store A from `StateStorePath`, loads the pre-seeded registry file from `HomeDir`, serves `/api/statestores` and `/api/workflows`).
- Consumes existing test helpers: `wiringFakeApps` + `httpGet` (`cmd/serve_integration_test.go:27`/`:44`), `statestore.New/SeedForTest/InstancePrefix/SuffixMetadata/HistoryPrefix`, `protos`/`proto`/`timestamppb`/`wrapperspb` (same imports as `serve_integration_test.go`), `sigs.k8s.io/yaml` for pre-seeding the registry file (or hand-build via the same `connFile` shape — use `yaml.Marshal` of a literal map to avoid coupling to internal types).

- [ ] **Step 1: Write the failing test**

Create `cmd/connection_registry_integration_test.go`:

```go
//go:build integration

package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"sigs.k8s.io/yaml"
)

// seedWorkflowInstance writes one workflow instance into a sqlite store at dbPath.
func seedWorkflowInstance(t *testing.T, dbPath, namespace, appID, instanceID, wfName string) {
	t.Helper()
	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "seed", Type: "state.sqlite", Version: "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  wfName,
				Input: &wrapperspb.StringValue{Value: `{}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix(namespace, appID, instanceID)
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())
}

// TestConnectionRegistry_AutoAndManualThroughLazyPool wires the real server with
// an auto-detected SQLite store A (active) and a pre-seeded registry file holding
// a manual SQLite store B. It asserts the list endpoint reports both with correct
// source/active, that B's workflows load lazily via ?store=B, and that the no-store
// default view returns A's instance.
func TestConnectionRegistry_AutoAndManualThroughLazyPool(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	// Store A: auto-detected from a component YAML, seeded with instance A1.
	dbA := filepath.Join(dir, "a.db")
	seedWorkflowInstance(t, dbA, "default", "order", "inst-A", "OrderWorkflow")
	compA := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: storeA\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbA + "\n"
	compPathA := filepath.Join(dir, "storeA.yaml")
	require.NoError(t, os.WriteFile(compPathA, []byte(compA), 0o644))

	// Store B: manual, seeded with instance B1, pre-written into the registry file.
	dbB := filepath.Join(dir, "b.db")
	seedWorkflowInstance(t, dbB, "default", "billing", "inst-B", "BillingWorkflow")
	regDir := filepath.Join(home, ".dapr", "dev-dashboard")
	require.NoError(t, os.MkdirAll(regDir, 0o700))
	regDoc := map[string]any{
		"connections": []map[string]any{
			{
				"name": "storeB", "type": "state.sqlite", "source": "manual",
				"metadata": map[string]string{"connectionString": dbB},
			},
		},
	}
	regYAML, err := yaml.Marshal(regDoc)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(regDir, "connections.yaml"), regYAML, 0o600))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	opts, closers := assembleOptions(context.Background(), serveDeps{
		StateStorePath: compPathA,
		Namespace:      "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy},
		}},
		HomeDir:    home,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// GET /api/statestores lists BOTH stores with correct source + active.
	res, body := httpGet(t, srv.URL+"/api/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"storeA"`)
	require.Contains(t, body, `"name":"storeB"`)
	require.Contains(t, body, `"source":"auto"`)
	require.Contains(t, body, `"source":"manual"`)
	// storeA is the elected active store.
	require.Regexp(t, `"name":"storeA"[^}]*"active":true`, body)

	// GET /api/workflows?store=storeB returns B's instance via the lazy pool.
	res, body = httpGet(t, srv.URL+"/api/workflows?store=storeB")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-B"`)
	require.NotContains(t, body, `"instanceId":"inst-A"`, "store=B must not see store A's data")

	// GET /api/workflows (no store) returns the active store A's view.
	res, body = httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-A"`)
	require.NotContains(t, body, `"instanceId":"inst-B"`, "the default view is store A only")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags integration ./cmd/ -run TestConnectionRegistry`
Expected: This test should PASS once Tasks 1–4 are in place — it is an integration assertion over already-implemented behavior, written last. To confirm it is exercising real wiring, first run it against a deliberately empty registry by temporarily renaming the pre-seed step: it must FAIL the `storeB` assertions. (If running strictly TDD, stash the registry pre-seed lines, observe FAIL `expected body to contain "name":"storeB"`, then restore them.)

- [ ] **Step 3: Write minimal implementation**

No production code changes — Tasks 1–4 already implement everything this test exercises. If the test fails for a real reason, debug per `superpowers:systematic-debugging` (likely culprits: `Stores()` not iterating registry entries; `componentFor` not reading the auto YAML; the registry file not loaded from `HomeDir`).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags integration ./cmd/ -run TestConnectionRegistry`
Expected: PASS. Then run the full integration suite to confirm no regression: `go test -tags integration ./cmd/...`
Expected: PASS (both `TestAssembleServerServesSeededWorkflow` and the new test).

- [ ] **Step 5: Commit**

```bash
git add cmd/connection_registry_integration_test.go
git commit -m "test(cmd): integration test for auto+manual stores via the lazy connection pool"
```

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task |
| --- | --- |
| Persisted registry file `~/.dapr/dev-dashboard/connections.yaml`, YAML, `0600` | Task 1 (`registryPath`, `save`) |
| Hybrid entries: auto = path ref (no secrets), manual = inline metadata | Task 1 (`ConnEntry.Path` vs `.Metadata`); Task 3 (auto-persist stores path only) |
| Auto-persist every discovered store, deduped | Task 1 (`UpsertAuto` dedup by normalized path); Task 3 (`reconcile` calls `UpsertAuto`) |
| Auto entries keyed by normalized abs path, case-insensitive on Windows | Task 1 (`normPath` + `filepath.Clean` + `runtime.GOOS`) |
| Manual entries keyed by name | Task 1 (`Add`/`Update` by name) |
| Auto-persist never overwrites manual | Task 1 (`UpsertAuto` manual guard); tested |
| CRUD: manual add/edit/remove; any entry delete | Task 1 (`Add`/`Update`/`Delete`) |
| Malformed file → empty registry, no crash | Task 1 (`LoadRegistry` malformed branch); tested |
| Cross-platform via `sigs.k8s.io/yaml` marshaler | Task 1 (`save`/`LoadRegistry`); Windows backslash round-trip tested |
| Saves serialized under a mutex | Task 1 (`ConnRegistry.mu`) |
| connpool keyed by identity `name|type|ConnInfo` | Task 2 (`openOrGet` uses `identity(&c)`) |
| Lazy `openOrGet`; injected opener; default `statestore.New` | Task 2 (`newConnPool` open==nil default) |
| Per-identity single-flight; open outside the lock | Task 2 (`poolSlot.done` + unlock before `p.open`); tested |
| Retention: don't close old on active change | Task 2 (`TestConnPool_TwoIdentitiesBothRetained`); Task 3 reconcile no longer closes |
| `Close()` closes all | Task 2 (`Close`); tested |
| `buildStoreEntry` extracted from `newStoreBackend` | Task 2 (added); Task 3 reuses it + retires `newStoreBackend` |
| Reconciler holds registry + pool, no closers | Task 3 (struct rewrite) |
| reconcile auto-persists + pre-warms active via pool; removes open-new/close-old/retain-on-failure | Task 3 (`reconcile`) |
| `ServiceFor`: ""→active, named→registry entry→pool, unknown→ok=false | Task 3 (`ServiceFor` + `componentFor`); tested |
| `Close()` → `pool.Close()` | Task 3 |
| serve.go loads registry + builds pool, passes them in | Task 3 (`assembleOptions`) |
| Keep fingerprint/single-flight/Paths/reconcilingApps | Task 3 (unchanged methods retained) |
| `StoreInfo` gains `Source` | Task 4 |
| `StoreRegistry` gains `AddStore`/`UpdateStore`/`DeleteStore` | Task 4 (interface + reconciler impl) |
| POST/PUT/DELETE `/statestores` with supported-type + required-field validation, 400 on bad | Task 4 (`api.go` routes + `validateStoreBody`); tested |
| DELETE evicts pooled connection | Task 4 (`DeleteStore` → `pool.evict`) |
| `Stores()` returns ALL entries, Source set, active flag, no DB connect | Task 4 (`Stores()` rewrite via `componentFor` + `ConnInfo`); tested |
| Missing YAML for auto → empty connection, unreachable, not error | Task 3 (`componentFor` bare-component fallback) → Task 4 `Stores()` empty `ConnInfo` |
| List returns secrets-free `ConnInfo` only | Task 4 (`Stores()` uses `statestore.ConnInfo`, never raw metadata) |
| Integration: auto A active + manual B seeded; list both; `?store=B` lazy; no-store=A | Task 5 |

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `similar to above`, `add appropriate`, `handle edge cases`, `etc.` in step bodies. None present in code or command steps. Every code step contains complete, compilable code; every run step has an exact `-tags` command and an expected outcome. Task 5 Step 3 intentionally contains no production code (the test asserts already-built behavior) and says so explicitly with a debugging pointer rather than a placeholder.

### 3. Type consistency

- Registry entry type is `ConnEntry` everywhere (Tasks 1, 3, 4). Fields `Name/Type/Source/Path/Metadata` consistent.
- `Source` values are the constants `SourceAuto`/`SourceManual` (Task 1) and the string literals `"auto"`/`"manual"` in JSON assertions (Tasks 4, 5) — consistent.
- Registry methods: `List`, `UpsertAuto`, `Add`, `Update`, `Delete` — same names in Tasks 1, 3, 4.
- connpool: `newConnPool(namespace, client, apps, open)`, `openOrGet(ctx, c)`, `evict(c)`, `Close()` — identical across Tasks 2, 3, 4.
- `buildStoreEntry(st, namespace, client, apps) storeEntry` — defined Task 2, used Tasks 2 (pool), 3 (degraded + via pool).
- `newReconciler(apps, namespace, homeDir, stateStorePath, client, registry, pool)` — new 7-arg signature defined Task 3, called in Task 3 `serve.go` and Tasks 3/4 tests; old 5-arg call sites (serve.go) updated in Task 3.
- `StoreRegistry` mutator signatures `AddStore(name, typ string, metadata map[string]string) error`, `UpdateStore(name, typ string, metadata map[string]string) error`, `DeleteStore(name string) error` — identical in the interface (Task 4 `workflows.go`), the reconciler impl (Task 4 `reconciler.go`), the `mutableStoreRegistry` and `fakeStoreRegistry` test doubles (Task 4).
- `reconciler.electedReg` (renamed from the old `registry *storeRegistry` field, which now names the `*ConnRegistry`) — used consistently in Task 3 reconcile/activeComponent and Tasks 3/4 tests; the `*ConnRegistry` field is `registry`. No collision.
- `identity(*statestore.Component) string` — defined once (Task 3 reconciler.go), used by the pool (Task 2) and `Stores()` (Task 4).
