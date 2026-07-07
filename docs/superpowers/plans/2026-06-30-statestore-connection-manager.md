# State Store Connection Manager (2c-ii) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add, edit, and delete manual state-store connections from the dashboard via a metadata-driven form fed by a ported Dapr component catalog, saving to the existing connection registry.

**Architecture:** Add a component-catalog backend (`pkg/metadata`) and serve it at `GET /api/metadata/components`. Reimplement the form natively on dev-dashboard's React 18 + vanilla-CSS stack (no MUI). A "State store connections" panel on the Components page lists `/api/statestores`; an Add/Edit modal renders fields from the catalog and saves via `POST`/`PUT /api/statestores`.

**Tech Stack:** Go (chi, `//go:embed`, `internal/golden`), React 18 + TypeScript + Vite, TanStack Query v5, MSW + Vitest + Testing Library. No new dependencies.

## Global Constraints

- **Supported store types are exactly three:** `state.redis`, `state.sqlite`, `state.postgresql`. The frontend type picker and the backend allowlist (`validateStoreBody`) must agree. Do not expose other types.
- **No new dependencies** — backend or frontend. The slice saves JSON to the registry; no YAML emission, so no `js-yaml`.
- **Secrets hygiene:** manual connections store metadata **inline** in the `0600` registry file. No `secretKeyRef`. `sensitive` fields render masked but are sent/stored as plain values. Never log secret values.
- **Commit discipline:** commit ONLY the files a task touches via explicit `git add <paths>`. Never `git commit -am`. Leave the pre-existing uncommitted artifacts `web/dist/index.html` and `web/package-lock.json` untouched.
- **Go test commands:** unit `go test -tags unit -race ./...`; integration `go test -tags integration ./...`; build `go build ./...`. Golden regen: append `-run Golden -update`.
- **Web test commands (from `web/`):** single file `npx vitest run src/path/file.test.tsx`; full `npm test`; typecheck/build `npm run build`.
- **`actorStateStore` defaults to checked** in the form (registers workflow state stores).
- **Auto-discovered rows are read-only** (no edit/delete); only manual rows get edit/delete.

## File Structure

**Backend (new):**
- `pkg/metadata/metadata.go` — embeds + processes + serves the component catalog (ported, adapted to dev-dashboard handler conventions).
- `pkg/metadata/component-metadata-bundle.json` — copied catalog (754 KB).
- `pkg/metadata/metadata_test.go` — unit tests (build tag `unit`).
- `pkg/metadata/golden_test.go` + `pkg/metadata/testdata/catalog-summary.json` — golden of the processed (type,name,version,status) summary (build tag `integration`).
- `scripts/update-component-metadata-bundle.sh` — refresh helper (ported).

**Backend (modified):**
- `pkg/server/api.go` — register `GET /metadata/components`; `PUT` handler returns the new id.
- `pkg/server/workflows.go` — `StoreRegistry.UpdateStore` returns `(string, error)`.
- `pkg/server/statestores_test.go` — update the test double + assertions.
- `cmd/registry.go` — `ConnRegistry.Update` returns `(string, error)`; `Add` duplicate → friendly error.
- `cmd/reconciler.go` — `UpdateStore`/`AddStore` propagate the above.
- `cmd/root.go` — call `metadata.Init()` at startup.

**Frontend (new), under `web/src/`:**
- `types/metadata.ts` — `ComponentMetadataSchema`, `MetadataField`.
- `lib/storeTypes.ts` — `SUPPORTED_STORE_TYPES` constant + labels.
- `hooks/useComponentCatalog.ts` (+ `.test.tsx`) — fetch + select supported state schemas.
- `hooks/useStoreMutations.ts` (+ `.test.tsx`) — add/update/delete + invalidation.
- `components/Modal.tsx` (+ `.test.tsx`) — focus-trapped modal shell.
- `components/MetadataFieldInput.tsx` (+ `.test.tsx`) — one catalog field → control by type.
- `components/StateStoreConnectionDialog.tsx` (+ `.test.tsx`) — the add/edit form.
- `components/StateStoreConnectionsPanel.tsx` (+ `.test.tsx`) — the panel + delete confirm.

**Frontend (modified):**
- `pages/ResourceList.tsx` — render the panel above the master-detail when `kind === 'component'`.
- `styles/theme.css` — minimal modal/form input classes.

---

## Task 1: Port the component metadata catalog endpoint

**Files:**
- Create: `pkg/metadata/metadata.go`, `pkg/metadata/component-metadata-bundle.json`, `pkg/metadata/metadata_test.go`, `pkg/metadata/golden_test.go`, `pkg/metadata/testdata/catalog-summary.json`, `scripts/update-component-metadata-bundle.sh`
- Modify: `pkg/server/api.go` (register route), `cmd/root.go` (call `Init`)
- Test: `pkg/metadata/metadata_test.go` (unit), `pkg/metadata/golden_test.go` (integration)

**Interfaces:**
- Produces: `metadata.Init() error`, `metadata.HandleGetComponents(http.ResponseWriter, *http.Request)`. Frontend consumes `GET /api/metadata/components` returning `{schemaVersion, date, components: [...]}`.

- [ ] **Step 1: Fetch the bundle and create the refresh script**

```bash
mkdir -p pkg/metadata/testdata
```

Create `scripts/update-component-metadata-bundle.sh` with this content, then run it once to fetch the bundle:

```bash
#!/usr/bin/env bash
# Refresh pkg/metadata/component-metadata-bundle.json from the dapr/components-contrib
# release asset. Usage: scripts/update-component-metadata-bundle.sh <tag>
# Example tag: v1.18.1
set -euo pipefail
TAG="${1:?usage: update-component-metadata-bundle.sh <tag>}"
DEST="$(dirname "$0")/../pkg/metadata/component-metadata-bundle.json"
URL="https://github.com/dapr/components-contrib/releases/download/${TAG}/component-metadata-bundle.json"
echo "Downloading ${URL}"
curl -fsSL "$URL" -o "$DEST"
echo "Wrote $DEST"
```

```bash
chmod +x scripts/update-component-metadata-bundle.sh
```

- [ ] **Step 2: Write the failing unit tests**

Create `pkg/metadata/metadata_test.go`:

```go
//go:build unit

package metadata

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInitAndServe(t *testing.T) {
	require.NoError(t, Init())

	req := httptest.NewRequest(http.MethodGet, "/metadata/components", nil)
	rec := httptest.NewRecorder()
	HandleGetComponents(rec, req)

	res := rec.Result()
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/json", res.Header.Get("Content-Type"))
	require.NotEmpty(t, res.Header.Get("ETag"))
	require.Contains(t, rec.Body.String(), `"type":"state"`)
}

func TestETagNotModified(t *testing.T) {
	require.NoError(t, Init())

	// First request to learn the ETag.
	rec1 := httptest.NewRecorder()
	HandleGetComponents(rec1, httptest.NewRequest(http.MethodGet, "/metadata/components", nil))
	etag := rec1.Result().Header.Get("ETag")
	require.NotEmpty(t, etag)

	// Conditional request with matching ETag → 304.
	req := httptest.NewRequest(http.MethodGet, "/metadata/components", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	HandleGetComponents(rec2, req)
	require.Equal(t, http.StatusNotModified, rec2.Result().StatusCode)
}

func TestProcessingInvariants(t *testing.T) {
	require.NoError(t, Init())

	var b Bundle
	require.NoError(t, parseProcessed(&b))

	// No deprecated-status components survive.
	for _, c := range b.Components {
		require.NotEqual(t, "deprecated", c.Status)
	}
	// Sorted by type ascending.
	for i := 1; i < len(b.Components); i++ {
		require.LessOrEqual(t, b.Components[i-1].Type, b.Components[i].Type)
	}
	// At least one supported state store with its key field present.
	var foundRedisHost bool
	for _, c := range b.Components {
		if c.Type == "state" && c.Name == "redis" {
			for _, f := range c.Metadata {
				if f.Name == "redisHost" {
					foundRedisHost = true
				}
			}
		}
	}
	require.True(t, foundRedisHost, "state.redis should expose redisHost")
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/metadata/`
Expected: FAIL — `metadata` package / `Init` / `HandleGetComponents` / `parseProcessed` undefined.

- [ ] **Step 4: Write `metadata.go`**

Create `pkg/metadata/metadata.go` (ported from the sibling repo, adapted: no `restservice`/`handler` import — write JSON directly; add `parseProcessed` test helper):

```go
package metadata

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

//go:embed component-metadata-bundle.json
var rawMetadataBundle []byte

var (
	processedBundle []byte
	bundleETag      string
)

// Bundle is the top-level structure of the component metadata bundle.
type Bundle struct {
	SchemaVersion string               `json:"schemaVersion"`
	Date          string               `json:"date"`
	Components    []*ComponentMetadata `json:"components"`
}

// ComponentMetadata describes a single Dapr component's metadata.
type ComponentMetadata struct {
	SchemaVersion          string                  `json:"schemaVersion"`
	Type                   string                  `json:"type"`
	Name                   string                  `json:"name"`
	Version                string                  `json:"version"`
	Status                 string                  `json:"status"`
	Title                  string                  `json:"title"`
	Description            string                  `json:"description,omitempty"`
	URLs                   []URL                   `json:"urls"`
	Binding                *CMPBinding             `json:"binding,omitempty"`
	Capabilities           []string                `json:"capabilities,omitempty"`
	AuthenticationProfiles []AuthenticationProfile `json:"authenticationProfiles,omitempty"`
	Metadata               []Field                 `json:"metadata,omitempty"`
	IconURI                string                  `json:"iconURI,omitempty"`
}

// URL represents a documentation link.
type URL struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// CMPBinding holds binding-specific properties.
type CMPBinding struct {
	Input      bool               `json:"input,omitempty"`
	Output     bool               `json:"output,omitempty"`
	Operations []BindingOperation `json:"operations"`
}

// BindingOperation describes a binding operation.
type BindingOperation struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// AuthenticationProfile describes an authentication option.
type AuthenticationProfile struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Metadata    []Field `json:"metadata,omitempty"`
}

// Field describes a single metadata property.
type Field struct {
	Name          string        `json:"name"`
	Description   string        `json:"description"`
	Required      bool          `json:"required,omitempty"`
	Sensitive     bool          `json:"sensitive,omitempty"`
	Type          string        `json:"type,omitempty"`
	Default       string        `json:"default,omitempty"`
	Example       string        `json:"example"`
	AllowedValues []string      `json:"allowedValues,omitempty"`
	Binding       *FieldBinding `json:"binding,omitempty"`
	URL           *URL          `json:"url,omitempty"`
	Deprecated    bool          `json:"deprecated,omitempty"`
}

// FieldBinding constrains a metadata field to input/output bindings.
type FieldBinding struct {
	Input  bool `json:"input,omitempty"`
	Output bool `json:"output,omitempty"`
}

// Init loads, processes, and caches the component metadata bundle. It must be
// called once at startup before HandleGetComponents is used.
func Init() error {
	var b Bundle
	if err := json.Unmarshal(rawMetadataBundle, &b); err != nil {
		return fmt.Errorf("failed to unmarshal component metadata bundle: %w", err)
	}

	filterDeprecated(&b)
	deduplicateMetadata(&b)
	sortComponents(&b)

	out, err := json.Marshal(&b)
	if err != nil {
		return fmt.Errorf("failed to marshal processed metadata bundle: %w", err)
	}
	processedBundle = out

	hash := sha256.Sum256(processedBundle)
	bundleETag = fmt.Sprintf("%q", hex.EncodeToString(hash[:]))
	return nil
}

// parseProcessed unmarshals the cached processed bundle (test/golden helper).
func parseProcessed(b *Bundle) error { return json.Unmarshal(processedBundle, b) }

func filterDeprecated(b *Bundle) {
	filtered := make([]*ComponentMetadata, 0, len(b.Components))
	for _, comp := range b.Components {
		if strings.EqualFold(comp.Status, "deprecated") {
			continue
		}
		filtered = append(filtered, comp)
	}
	b.Components = filtered
}

func deduplicateMetadata(b *Bundle) {
	seen := make(map[string]struct{}, len(b.Components))
	deduped := make([]*ComponentMetadata, 0, len(b.Components))
	for _, comp := range b.Components {
		key := comp.Type + "." + comp.Name + "." + comp.Version
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		deduplicateMetadataFields(comp)
		deduped = append(deduped, comp)
	}
	b.Components = deduped
}

func deduplicateMetadataFields(comp *ComponentMetadata) {
	idx := 0
	nameToIdx := make(map[string]int, len(comp.Metadata))
	for i, md := range comp.Metadata {
		if prevIdx, exists := nameToIdx[md.Name]; exists {
			comp.Metadata[prevIdx] = md
		} else {
			nameToIdx[md.Name] = idx
			if i != idx {
				comp.Metadata[idx] = md
			}
			idx++
		}
	}
	comp.Metadata = comp.Metadata[:idx]
}

func sortComponents(b *Bundle) {
	sort.Slice(b.Components, func(i, j int) bool {
		ci, cj := b.Components[i], b.Components[j]
		if ci.Type != cj.Type {
			return ci.Type < cj.Type
		}
		si, sj := statusOrder(ci.Status), statusOrder(cj.Status)
		if si != sj {
			return si < sj
		}
		return ci.Title < cj.Title
	})
}

func statusOrder(status string) int {
	switch status {
	case "stable":
		return 0
	case "beta":
		return 1
	case "alpha":
		return 2
	default:
		return 3
	}
}

// HandleGetComponents serves the processed component metadata bundle as JSON.
func HandleGetComponents(w http.ResponseWriter, r *http.Request) {
	if match := r.Header.Get("If-None-Match"); match != "" && match == bundleETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
	w.Header().Set("ETag", bundleETag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(processedBundle)
}
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `go test -tags unit ./pkg/metadata/`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the golden test (integration)**

Create `pkg/metadata/golden_test.go`:

```go
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
```

- [ ] **Step 7: Generate the golden file and run the integration test**

Run: `go test -tags integration ./pkg/metadata/ -run Golden -update`
Then: `go test -tags integration ./pkg/metadata/ -run Golden`
Expected: PASS; `pkg/metadata/testdata/catalog-summary.json` now exists.

- [ ] **Step 8: Register the route and call Init at startup**

In `pkg/server/api.go`, add the import and route. Add to the import block:

```go
	"github.com/diagridio/dev-dashboard/pkg/metadata"
```

Add this line inside `apiRouter`, right after the `r.Get("/version", ...)` block:

```go
	r.Get("/metadata/components", metadata.HandleGetComponents)
```

In `cmd/root.go`, inside `runServe`, after the `dist, err := web.DistFS()` block and before `addr := ...`, add:

```go
	if err := metadata.Init(); err != nil {
		logger.Error("component metadata bundle failed to load", "err", err)
		return fmt.Errorf("init component metadata: %w", err)
	}
```

Add the import to `cmd/root.go`:

```go
	"github.com/diagridio/dev-dashboard/pkg/metadata"
```

- [ ] **Step 9: Build and verify the full suite**

Run: `go build ./... && go test -tags unit -race ./... && go test -tags integration ./...`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add pkg/metadata/ scripts/update-component-metadata-bundle.sh pkg/server/api.go cmd/root.go
git commit -m "feat(metadata): port component catalog, serve GET /api/metadata/components

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `UpdateStore` returns the post-rename id

**Files:**
- Modify: `cmd/registry.go` (`Update` signature), `cmd/reconciler.go` (`UpdateStore` signature), `pkg/server/workflows.go` (interface), `pkg/server/api.go` (PUT handler), `pkg/server/statestores_test.go` (double + test)
- Test: `cmd/registry_test.go`, `cmd/reconciler_test.go`, `pkg/server/statestores_test.go`

**Interfaces:**
- Consumes: existing `entryID(SourceManual, name)`.
- Produces: `ConnRegistry.Update(e ConnEntry) (string, error)`; `reconciler.UpdateStore(id, name, typ, metadata) (string, error)`; `StoreRegistry.UpdateStore(...) (string, error)`. `PUT /statestores/{id}` returns `{"id": <newID>}`.

- [ ] **Step 1: Write the failing registry test**

Add to `cmd/registry_test.go` (the file already has `//go:build unit` and constructs registries with `LoadRegistry(t.TempDir())`):

```go
func TestUpdateReturnsNewID(t *testing.T) {
	r := LoadRegistry(t.TempDir())
	require.NoError(t, r.Add(ConnEntry{Name: "old", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}}))

	oldID := entryID(SourceManual, "old")
	newID, err := r.Update(ConnEntry{ID: oldID, Name: "renamed", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}})
	require.NoError(t, err)
	require.Equal(t, entryID(SourceManual, "renamed"), newID)
	require.NotEqual(t, oldID, newID)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test -tags unit ./cmd/ -run TestUpdateReturnsNewID`
Expected: FAIL — `Update` returns a single value, assignment mismatch (won't compile).

- [ ] **Step 3: Change `ConnRegistry.Update` to return the new id**

In `cmd/registry.go`, replace the `Update` method:

```go
// Update replaces a manual entry matched by ID; errors if none exists. The id
// is recomputed from the (possibly new) name so it stays deterministic, and the
// new id is returned so callers can re-address the renamed entry.
func (r *ConnRegistry) Update(e ConnEntry) (string, error) {
	e.Source = SourceManual
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && r.entries[i].ID == e.ID {
			e.ID = entryID(SourceManual, e.Name)
			r.entries[i] = e
			if err := r.save(); err != nil {
				return "", err
			}
			return e.ID, nil
		}
	}
	return "", os.ErrNotExist
}
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `go test -tags unit ./cmd/ -run TestUpdateReturnsNewID`
Expected: PASS.

- [ ] **Step 5: Propagate through the reconciler**

In `cmd/reconciler.go`, replace `UpdateStore`:

```go
// UpdateStore satisfies server.StoreRegistry: edits the manual connection with
// the given id, evicts its pooled connection (resolved before the update) so the
// next select reconnects with new metadata, and returns the recomputed id.
func (rc *reconciler) UpdateStore(id, name, typ string, metadata map[string]string) (string, error) {
	if rc.registry == nil {
		return id, nil
	}
	oldComp, hadOld := rc.componentFor(id)
	newID, err := rc.registry.Update(ConnEntry{ID: id, Name: name, Type: typ, Source: SourceManual, Metadata: metadata})
	if err != nil {
		return "", err
	}
	if hadOld && rc.pool != nil {
		rc.pool.evict(oldComp)
	}
	return newID, nil
}
```

Update the existing assertion in `cmd/reconciler_test.go` (in `TestReconciler_StoresListsAllEntriesAndMutators`, the `rc.UpdateStore(pgID, ...)` call) to capture both return values:

```go
	// UpdateStore mutates the manual entry, addressed by id, and returns the new id.
	newID, err := rc.UpdateStore(pgID, "manualpg", "state.postgresql", map[string]string{"connectionString": "host=h2 dbname=d2"})
	require.NoError(t, err)
	require.Equal(t, pgID, newID) // same name → same id
```

- [ ] **Step 6: Update the server interface**

In `pkg/server/workflows.go`, change the `StoreRegistry` interface line:

```go
	UpdateStore(id, name, typ string, metadata map[string]string) (string, error)
```

- [ ] **Step 7: Return the new id from the PUT handler**

In `pkg/server/api.go`, replace the `UpdateStore` call + response inside the `sr.Put("/{id}", ...)` handler:

```go
				newID, err := stores.UpdateStore(id, body.Name, body.Type, body.Metadata)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, map[string]string{"id": newID})
```

- [ ] **Step 8: Update the server test double and assertion**

In `pkg/server/statestores_test.go`, change the double's `UpdateStore`:

```go
func (m *mutableStoreRegistry) UpdateStore(id, name, typ string, metadata map[string]string) (string, error) {
	if m.updateErr != nil {
		return "", m.updateErr
	}
	newID := "id-" + name // mirror the registry recomputing id from name
	m.updated = append(m.updated, StoreInfo{ID: newID, Name: name, Type: typ, Source: "manual"})
	return newID, nil
}
```

Update `TestStateStores_PutUpdates` to assert the response body carries the new id:

```go
func TestStateStores_PutUpdates(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	req, body := putJSON(t, h, "/statestores/abc123def456",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=b"}}`)
	require.Equal(t, http.StatusOK, req.StatusCode, body)
	require.Len(t, reg.updated, 1)
	require.Equal(t, "id-pg", reg.updated[0].ID)
	require.Contains(t, body, `"id":"id-pg"`)
}
```

- [ ] **Step 9: Build and run the full suite**

Run: `go build ./... && go test -tags unit -race ./... && go test -tags integration ./...`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add cmd/registry.go cmd/registry_test.go cmd/reconciler.go cmd/reconciler_test.go pkg/server/workflows.go pkg/server/api.go pkg/server/statestores_test.go
git commit -m "feat(statestores): return post-rename id from UpdateStore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Friendly duplicate-name error on Add

**Files:**
- Modify: `cmd/reconciler.go` (`AddStore` maps `os.ErrExist`)
- Test: `cmd/reconciler_test.go`

**Interfaces:**
- Consumes: `ConnRegistry.Add` returning `os.ErrExist` on a duplicate manual name.
- Produces: `reconciler.AddStore` returns `error` whose message is `a connection named "<name>" already exists` on duplicate.

- [ ] **Step 1: Write the failing test**

Add to `cmd/reconciler_test.go` (`//go:build unit`). Build `rc` with the same constructors the other reconciler tests use (`LoadRegistry`, `newConnPool`, `newReconciler`, `fakeOpener` — all already defined in that test file / package):

```go
func TestAddStoreDuplicateNameFriendlyError(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	require.NoError(t, rc.AddStore("dup", "state.redis", map[string]string{"redisHost": "h"}))
	err := rc.AddStore("dup", "state.redis", map[string]string{"redisHost": "h"})
	require.Error(t, err)
	require.Contains(t, err.Error(), `a connection named "dup" already exists`)
}
```

> `net/http` is already imported by `cmd/reconciler_test.go`; no new imports needed.

- [ ] **Step 2: Run to verify it fails**

Run: `go test -tags unit ./cmd/ -run TestAddStoreDuplicateNameFriendlyError`
Expected: FAIL — error is `file already exists`, not the friendly message.

- [ ] **Step 3: Map the error in `AddStore`**

In `cmd/reconciler.go`, replace `AddStore`:

```go
// AddStore satisfies server.StoreRegistry: adds a manual connection. The
// registry assigns its stable id from the name. A duplicate name is reported
// with a user-facing message (the API surfaces err.Error() in the 400 body).
func (rc *reconciler) AddStore(name, typ string, metadata map[string]string) error {
	if rc.registry == nil {
		return nil
	}
	err := rc.registry.Add(ConnEntry{Name: name, Type: typ, Source: SourceManual, Metadata: metadata})
	if errors.Is(err, os.ErrExist) {
		return fmt.Errorf("a connection named %q already exists", name)
	}
	return err
}
```

Ensure `errors`, `fmt`, and `os` are imported in `cmd/reconciler.go` (add any missing).

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./cmd/ -run TestAddStoreDuplicateNameFriendlyError`
Expected: PASS.

- [ ] **Step 5: Build and run the full suite**

Run: `go build ./... && go test -tags unit -race ./... && go test -tags integration ./...`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(statestores): friendly duplicate-name error on add

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Catalog types, supported-types constant, and `useComponentCatalog`

**Files:**
- Create: `web/src/types/metadata.ts`, `web/src/lib/storeTypes.ts`, `web/src/hooks/useComponentCatalog.ts`, `web/src/hooks/useComponentCatalog.test.tsx`

**Interfaces:**
- Produces: `ComponentMetadataSchema`, `MetadataField` (types); `SUPPORTED_STORE_TYPES: readonly string[]`, `storeTypeLabel(type)`; `useComponentCatalog()` returning `{ schemas, fieldsFor, isLoading, isError }` where `schemas` are the supported `state.*` schemas and `fieldsFor(type)` returns `MetadataField[]`.

- [ ] **Step 1: Write the types and constant**

Create `web/src/types/metadata.ts`:

```ts
export interface MetadataField {
  name: string
  type?: 'string' | 'number' | 'bool' | 'duration'
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: string
  example?: string
  allowedValues?: string[]
  url?: { title: string; url: string }
}

export interface ComponentMetadataSchema {
  type: string
  name: string
  version: string
  title: string
  status: string
  description?: string
  metadata?: MetadataField[]
}

export interface MetadataBundle {
  schemaVersion: string
  date: string
  components: ComponentMetadataSchema[]
}
```

Create `web/src/lib/storeTypes.ts`:

```ts
// The state store types the backend can actually connect to (must match the
// allowlist in pkg/server/api.go validateStoreBody).
export const SUPPORTED_STORE_TYPES = ['state.redis', 'state.sqlite', 'state.postgresql'] as const

const LABELS: Record<string, string> = {
  'state.redis': 'Redis',
  'state.sqlite': 'SQLite',
  'state.postgresql': 'PostgreSQL',
}

export function storeTypeLabel(type: string): string {
  return LABELS[type] ?? type
}

// "state.redis" → "redis" (catalog component name).
export function implFor(type: string): string {
  return type.startsWith('state.') ? type.slice('state.'.length) : type
}
```

- [ ] **Step 2: Write the failing hook test**

Create `web/src/hooks/useComponentCatalog.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { useComponentCatalog } from './useComponentCatalog'

const bundle = {
  schemaVersion: 'v1',
  date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }, { name: 'redisPassword', sensitive: true, type: 'string' }] },
    { type: 'state', name: 'postgresql', version: 'v1', title: 'PostgreSQL', status: 'stable',
      metadata: [{ name: 'connectionString', required: true, sensitive: true, type: 'string' }] },
    { type: 'state', name: 'mongodb', version: 'v1', title: 'MongoDB', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'redis', version: 'v1', title: 'Redis PubSub', status: 'stable', metadata: [] },
  ],
}

function Probe() {
  const { schemas, fieldsFor, isLoading } = useComponentCatalog()
  if (isLoading) return <div>loading</div>
  return (
    <div>
      <span data-testid="types">{schemas.map((s) => s.type + '.' + s.name).join(',')}</span>
      <span data-testid="redis-fields">{fieldsFor('state.redis').map((f) => f.name).join(',')}</span>
    </div>
  )
}

describe('useComponentCatalog', () => {
  it('keeps only supported state.* types and resolves fields', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    render(<QueryProvider><Probe /></QueryProvider>)
    // mongodb is filtered out (unsupported); pubsub.redis excluded (not state).
    await waitFor(() => expect(screen.getByTestId('types')).toHaveTextContent('state.redis,state.postgresql'))
    expect(screen.getByTestId('redis-fields')).toHaveTextContent('redisHost,redisPassword')
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run (from `web/`): `npx vitest run src/hooks/useComponentCatalog.test.tsx`
Expected: FAIL — `useComponentCatalog` not found.

- [ ] **Step 4: Implement the hook**

Create `web/src/hooks/useComponentCatalog.ts`:

```ts
import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { MetadataBundle, ComponentMetadataSchema, MetadataField } from '../types/metadata'
import { SUPPORTED_STORE_TYPES, implFor } from '../lib/storeTypes'

const SUPPORTED_NAMES = new Set(SUPPORTED_STORE_TYPES.map(implFor))

export function useComponentCatalog() {
  const query = useQuery<MetadataBundle>({
    queryKey: ['metadata', 'components'],
    queryFn: () => fetchJSON<MetadataBundle>('/metadata/components'),
    staleTime: 60 * 60 * 1000, // catalog is static + ETag-cached
  })

  const schemas: ComponentMetadataSchema[] = (query.data?.components ?? []).filter(
    (c) => c.type === 'state' && SUPPORTED_NAMES.has(c.name),
  )

  function fieldsFor(type: string): MetadataField[] {
    const name = implFor(type)
    // Prefer a stable entry if multiple versions exist; else first match.
    const matches = schemas.filter((s) => s.name === name)
    const chosen = matches.find((s) => s.status === 'stable') ?? matches[0]
    return chosen?.metadata ?? []
  }

  return { schemas, fieldsFor, isLoading: query.isLoading, isError: query.isError }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/hooks/useComponentCatalog.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run build`
Expected: PASS.

```bash
git add web/src/types/metadata.ts web/src/lib/storeTypes.ts web/src/hooks/useComponentCatalog.ts web/src/hooks/useComponentCatalog.test.tsx
git commit -m "feat(web): component catalog hook + supported store types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `useStoreMutations` (add / update / delete)

**Files:**
- Create: `web/src/hooks/useStoreMutations.ts`, `web/src/hooks/useStoreMutations.test.tsx`

**Interfaces:**
- Consumes: `apiUrl` from `lib/api`; existing query key `['statestores']` (from `useStateStores`).
- Produces: `useStoreMutations()` → `{ addStore, updateStore, deleteStore }`, each a TanStack `useMutation` result. `addStore.mutateAsync({name, type, metadata})`; `updateStore.mutateAsync({id, name, type, metadata})` → `{id}`; `deleteStore.mutateAsync(id)`. All invalidate `['statestores']` on success. Non-2xx throws an `Error` whose message is the server `{error}` body.

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/useStoreMutations.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { useStoreMutations } from './useStoreMutations'

function Probe() {
  const { addStore } = useStoreMutations()
  return (
    <div>
      <button onClick={() => addStore.mutateAsync({ name: 'r', type: 'state.redis', metadata: { redisHost: 'h' } }).catch((e) => {
        document.title = (e as Error).message
      })}>add</button>
      <span data-testid="status">{addStore.isSuccess ? 'ok' : addStore.isError ? 'err' : 'idle'}</span>
    </div>
  )
}

describe('useStoreMutations', () => {
  it('posts a new store and reports success', async () => {
    let received: unknown = null
    server.use(http.post('/api/statestores', async ({ request }) => {
      received = await request.json()
      return HttpResponse.json({ name: 'r' }, { status: 201 })
    }))
    render(<QueryProvider><Probe /></QueryProvider>)
    screen.getByText('add').click()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ok'))
    expect(received).toEqual({ name: 'r', type: 'state.redis', metadata: { redisHost: 'h' } })
  })

  it('surfaces the server error message on failure', async () => {
    server.use(http.post('/api/statestores', () =>
      HttpResponse.json({ error: 'a connection named "r" already exists' }, { status: 400 })))
    render(<QueryProvider><Probe /></QueryProvider>)
    screen.getByText('add').click()
    await waitFor(() => expect(document.title).toBe('a connection named "r" already exists'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/hooks/useStoreMutations.test.tsx`
Expected: FAIL — `useStoreMutations` not found.

- [ ] **Step 3: Implement the hook**

Create `web/src/hooks/useStoreMutations.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export interface StorePayload {
  name: string
  type: string
  metadata: Record<string, string>
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // non-JSON body; keep status-only message
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function useStoreMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['statestores'] })

  const addStore = useMutation({
    mutationFn: (p: StorePayload) => send<{ name: string }>('/statestores', 'POST', p),
    onSuccess: invalidate,
  })
  const updateStore = useMutation({
    mutationFn: ({ id, ...p }: StorePayload & { id: string }) =>
      send<{ id: string }>(`/statestores/${encodeURIComponent(id)}`, 'PUT', p),
    onSuccess: invalidate,
  })
  const deleteStore = useMutation({
    mutationFn: (id: string) => send<void>(`/statestores/${encodeURIComponent(id)}`, 'DELETE'),
    onSuccess: invalidate,
  })

  return { addStore, updateStore, deleteStore }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/useStoreMutations.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run build`

```bash
git add web/src/hooks/useStoreMutations.ts web/src/hooks/useStoreMutations.test.tsx
git commit -m "feat(web): store add/update/delete mutations hook

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Modal shell component

**Files:**
- Create: `web/src/components/Modal.tsx`, `web/src/components/Modal.test.tsx`
- Modify: `web/src/styles/theme.css` (modal classes)

**Interfaces:**
- Produces: `Modal({ open, title, onClose, children })`. Renders nothing when `!open`. Backdrop click and `Escape` call `onClose`. Focus moves into the dialog on open. `role="dialog"`, `aria-modal="true"`, `aria-labelledby` tied to the title.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/Modal.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false} title="X" onClose={() => {}}>body</Modal>)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows title and content when open', () => {
    render(<Modal open title="Add connection" onClose={() => {}}><p>hello</p></Modal>)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Add connection')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Modal open title="X" onClose={onClose}>body</Modal>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/Modal.test.tsx`
Expected: FAIL — `Modal` not found.

- [ ] **Step 3: Implement the modal**

Create `web/src/components/Modal.tsx`:

```tsx
import { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}

export function Modal({ open, title, onClose, children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const t = setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      clearTimeout(t)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="none"
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="card modal-card"
      >
        <h2 id="modal-title" className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add modal + form CSS**

Append to `web/src/styles/theme.css`:

```css
/* --- Modal + form controls (connection manager) --- */
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
.modal-card { max-width: 560px; width: 100%; max-height: 85vh; overflow-y: auto; padding: 22px 24px; }
.modal-title { margin: 0 0 14px; font-size: 16px; font-weight: 700; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.field { display: grid; gap: 4px; margin-bottom: 11px; }
.field > label { font-size: 12px; color: var(--muted); }
.field .req { color: var(--fail-fg); }
.inp { font: inherit; font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 7px 11px; width: 100%; }
.inp:focus-visible { outline: 2px solid var(--accent2); outline-offset: 1px; }
.field-err { color: var(--fail-fg); font-size: 11px; margin-top: 2px; }
.field-row { display: flex; align-items: center; gap: 8px; }
.section-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); border-top: 1px solid var(--line-soft); padding-top: 10px; margin: 6px 0 8px; }
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run src/components/Modal.test.tsx && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Modal.tsx web/src/components/Modal.test.tsx web/src/styles/theme.css
git commit -m "feat(web): focus-trapped Modal shell + form CSS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `MetadataFieldInput` — render one catalog field by type

**Files:**
- Create: `web/src/components/MetadataFieldInput.tsx`, `web/src/components/MetadataFieldInput.test.tsx`

**Interfaces:**
- Consumes: `MetadataField` from `types/metadata`.
- Produces: `MetadataFieldInput({ field, value, onChange })`. `value: string`, `onChange: (v: string) => void`. Renders by `field.type`/flags: `bool` → checkbox (value `"true"`/`""`), enum (`allowedValues`) → `select.inp`, `sensitive` → `input[type=password]`, `number` → `input[type=number]`, else text. Input has `aria-label={field.name}`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/MetadataFieldInput.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MetadataFieldInput } from './MetadataFieldInput'

describe('MetadataFieldInput', () => {
  it('renders a masked input for sensitive fields', () => {
    render(<MetadataFieldInput field={{ name: 'redisPassword', sensitive: true, type: 'string' }} value="s" onChange={() => {}} />)
    expect(screen.getByLabelText('redisPassword')).toHaveAttribute('type', 'password')
  })

  it('renders a select for allowedValues and reports changes', () => {
    const onChange = vi.fn()
    render(<MetadataFieldInput field={{ name: 'failover', allowedValues: ['sentinel', 'cluster'] }} value="" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('failover'), { target: { value: 'cluster' } })
    expect(onChange).toHaveBeenCalledWith('cluster')
  })

  it('renders a checkbox for bool fields mapping to true/empty', () => {
    const onChange = vi.fn()
    render(<MetadataFieldInput field={{ name: 'enableTLS', type: 'bool' }} value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('enableTLS'))
    expect(onChange).toHaveBeenCalledWith('true')
  })

  it('renders a number input for number fields', () => {
    render(<MetadataFieldInput field={{ name: 'maxRetries', type: 'number' }} value="3" onChange={() => {}} />)
    expect(screen.getByLabelText('maxRetries')).toHaveAttribute('type', 'number')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/MetadataFieldInput.test.tsx`
Expected: FAIL — `MetadataFieldInput` not found.

- [ ] **Step 3: Implement the component**

Create `web/src/components/MetadataFieldInput.tsx`:

```tsx
import type { MetadataField } from '../types/metadata'

interface Props {
  field: MetadataField
  value: string
  onChange: (v: string) => void
}

export function MetadataFieldInput({ field, value, onChange }: Props) {
  if (field.allowedValues && field.allowedValues.length > 0) {
    return (
      <select className="inp" aria-label={field.name} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.allowedValues.map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    )
  }
  if (field.type === 'bool') {
    return (
      <input
        type="checkbox"
        aria-label={field.name}
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : '')}
      />
    )
  }
  const type = field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'
  return (
    <input
      className="inp"
      type={type}
      aria-label={field.name}
      value={value}
      placeholder={field.example ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/MetadataFieldInput.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run build`

```bash
git add web/src/components/MetadataFieldInput.tsx web/src/components/MetadataFieldInput.test.tsx
git commit -m "feat(web): metadata field input (control by field type)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `StateStoreConnectionDialog` — the add/edit form

**Files:**
- Create: `web/src/components/StateStoreConnectionDialog.tsx`, `web/src/components/StateStoreConnectionDialog.test.tsx`

**Interfaces:**
- Consumes: `Modal`, `MetadataFieldInput`, `useComponentCatalog`, `useStoreMutations`, `SUPPORTED_STORE_TYPES`, `storeTypeLabel`, `implFor`; `StateStore` from `types/workflow` (for edit prefill); `useToast` from `lib/toast`.
- Produces: `StateStoreConnectionDialog({ open, mode, initial, onClose })` where `mode: 'add' | 'edit'`, `initial?: StateStore` (required for edit). On save it calls `addStore`/`updateStore`, toasts, and `onClose()`. Type is disabled in edit mode. `actorStateStore` checkbox defaults checked in add mode.

Notes for the implementer:
- Form state: `name: string`, `type: string`, `values: Record<string,string>` (metadata field name → value), `optional: string[]` (added optional field names), `actorStateStore: boolean`, `error: string | null`.
- Required fields = `fieldsFor(type).filter(f => f.required)`; rendered always. Optional pool = the rest; rendered only when added via the picker.
- On save build `metadata`: include every required field value + each added optional field value (skip empty optional values), and set `metadata.actorStateStore = 'true'` when checked. Send `{name, type, metadata}`.
- Save is disabled until `name` non-empty and all required fields non-empty; number-typed fields must parse (`!Number.isNaN(Number(v))`).
- In edit mode, prefill `name`/`type` from `initial`; values cannot be prefilled from `StoreInfo` (it carries no metadata), so start required fields empty with a hint that re-entering values overwrites stored ones. (Acceptable for v1; the registry replaces metadata wholesale on update.)
- On `updateStore` success, ignore the returned `{id}` here (the panel re-fetches the list); just toast + close.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/StateStoreConnectionDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { StateStoreConnectionDialog } from './StateStoreConnectionDialog'

const catalog = {
  schemaVersion: 'v1', date: '2026', components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }, { name: 'redisPassword', sensitive: true, type: 'string' }] },
  ],
}

function setup(ui: React.ReactNode) {
  return render(<QueryProvider>{ui}</QueryProvider>)
}

describe('StateStoreConnectionDialog', () => {
  it('disables Save until required fields are filled, then POSTs', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(catalog)))
    let posted: any = null
    server.use(http.post('/api/statestores', async ({ request }) => {
      posted = await request.json()
      return HttpResponse.json({ name: 'orders' }, { status: 201 })
    }))

    setup(<StateStoreConnectionDialog open mode="add" onClose={() => {}} />)

    // Wait for catalog → required field present.
    await waitFor(() => expect(screen.getByLabelText('redisHost')).toBeInTheDocument())

    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    expect(save).toBeEnabled()

    fireEvent.click(save)
    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted).toEqual({
      name: 'orders',
      type: 'state.redis',
      metadata: { redisHost: 'localhost:6379', actorStateStore: 'true' },
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/StateStoreConnectionDialog.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the dialog**

Create `web/src/components/StateStoreConnectionDialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { MetadataFieldInput } from './MetadataFieldInput'
import { useComponentCatalog } from '../hooks/useComponentCatalog'
import { useStoreMutations } from '../hooks/useStoreMutations'
import { SUPPORTED_STORE_TYPES, storeTypeLabel } from '../lib/storeTypes'
import { useToast } from '../lib/toast'
import type { StateStore } from '../types/workflow'

interface Props {
  open: boolean
  mode: 'add' | 'edit'
  initial?: StateStore
  onClose: () => void
}

export function StateStoreConnectionDialog({ open, mode, initial, onClose }: Props) {
  const { fieldsFor, isError } = useComponentCatalog()
  const { addStore, updateStore } = useStoreMutations()
  const { toast, toastNode } = useToast()

  const [name, setName] = useState('')
  const [type, setType] = useState<string>(SUPPORTED_STORE_TYPES[0])
  const [values, setValues] = useState<Record<string, string>>({})
  const [optional, setOptional] = useState<string[]>([])
  const [actorStateStore, setActorStateStore] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setType(initial?.type ?? SUPPORTED_STORE_TYPES[0])
    setValues({})
    setOptional([])
    setActorStateStore(true)
    setError(null)
  }, [open, initial])

  const allFields = fieldsFor(type)
  const required = useMemo(() => allFields.filter((f) => f.required), [allFields])
  const optionalPool = useMemo(
    () => allFields.filter((f) => !f.required && !optional.includes(f.name)),
    [allFields, optional],
  )

  const setValue = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }))

  const numberInvalid = allFields.some(
    (f) => f.type === 'number' && (values[f.name] ?? '') !== '' && Number.isNaN(Number(values[f.name])),
  )
  const canSave =
    name.trim() !== '' && required.every((f) => (values[f.name] ?? '').trim() !== '') && !numberInvalid

  async function handleSave() {
    setError(null)
    const metadata: Record<string, string> = {}
    for (const f of required) metadata[f.name] = values[f.name]
    for (const n of optional) {
      const v = values[n] ?? ''
      if (v !== '') metadata[n] = v
    }
    if (actorStateStore) metadata.actorStateStore = 'true'

    try {
      if (mode === 'edit' && initial) {
        await updateStore.mutateAsync({ id: initial.id, name: name.trim(), type, metadata })
        toast.show(`Updated ${name.trim()}`)
      } else {
        await addStore.mutateAsync({ name: name.trim(), type, metadata })
        toast.show(`Added ${name.trim()}`)
      }
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const optionalByName = (n: string) => allFields.find((f) => f.name === n)

  return (
    <Modal open={open} title={mode === 'edit' ? 'Edit state store connection' : 'Add state store connection'} onClose={onClose}>
      {toastNode}
      {isError && <p className="field-err">Couldn’t load the component catalog; try reloading.</p>}

      <div className="field">
        <label htmlFor="ss-name">Name <span className="req">*</span></label>
        <input id="ss-name" aria-label="Name" className="inp" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="ss-type">Type</label>
        <select
          id="ss-type"
          aria-label="Type"
          className="inp"
          value={type}
          disabled={mode === 'edit'}
          onChange={(e) => {
            setType(e.target.value)
            setValues({})
            setOptional([])
          }}
        >
          {SUPPORTED_STORE_TYPES.map((t) => (
            <option key={t} value={t}>{storeTypeLabel(t)}</option>
          ))}
        </select>
      </div>

      <div className="section-label">Required fields</div>
      {required.map((f) => (
        <div className="field" key={f.name}>
          <label>{f.name} <span className="req">*</span></label>
          <MetadataFieldInput field={f} value={values[f.name] ?? ''} onChange={(v) => setValue(f.name, v)} />
        </div>
      ))}

      <div className="section-label">Optional fields</div>
      {optional.map((n) => {
        const f = optionalByName(n)
        if (!f) return null
        return (
          <div className="field" key={n}>
            <label>{n}</label>
            <div className="field-row">
              <MetadataFieldInput field={f} value={values[n] ?? ''} onChange={(v) => setValue(n, v)} />
              <button
                type="button"
                className="btn ghost"
                aria-label={`remove ${n}`}
                onClick={() => {
                  setOptional((prev) => prev.filter((x) => x !== n))
                  setValues((prev) => {
                    const next = { ...prev }
                    delete next[n]
                    return next
                  })
                }}
              >✕</button>
            </div>
          </div>
        )
      })}
      {optionalPool.length > 0 && (
        <select
          className="inp"
          aria-label="add optional field"
          value=""
          onChange={(e) => {
            if (e.target.value) setOptional((prev) => [...prev, e.target.value])
          }}
        >
          <option value="">+ add optional field…</option>
          {optionalPool.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
      )}

      <div className="field-row" style={{ marginTop: 12 }}>
        <input
          id="ss-actor"
          type="checkbox"
          checked={actorStateStore}
          onChange={(e) => setActorStateStore(e.target.checked)}
        />
        <label htmlFor="ss-actor">Use for actors / workflows (actorStateStore)</label>
      </div>

      {error && <p className="field-err">{error}</p>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!canSave} onClick={handleSave}>Save connection</button>
      </div>
    </Modal>
  )
}
```

> `useToast()` returns `{ toast: { show(text) }, toastNode }` (see `web/src/lib/toast.tsx`). The `toast.show(...)` calls and the `{toastNode}` render above are correct as written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/StateStoreConnectionDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run build`

```bash
git add web/src/components/StateStoreConnectionDialog.tsx web/src/components/StateStoreConnectionDialog.test.tsx
git commit -m "feat(web): metadata-driven add/edit connection dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `StateStoreConnectionsPanel` — list, add, edit, delete

**Files:**
- Create: `web/src/components/StateStoreConnectionsPanel.tsx`, `web/src/components/StateStoreConnectionsPanel.test.tsx`

**Interfaces:**
- Consumes: `useStateStores` (existing, in `hooks/useWorkflows`), `useStoreMutations`, `StateStoreConnectionDialog`, `Modal`, `storeTypeLabel`; `StateStore` type.
- Produces: `StateStoreConnectionsPanel()` — self-contained `.card` panel. Auto rows show type/connection + ACTIVE badge, no actions. Manual rows add Edit (opens dialog `mode="edit"`) and Delete (opens a `Modal` confirm → `deleteStore.mutateAsync(id)`). "+ Add connection" opens the dialog `mode="add"`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/StateStoreConnectionsPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { StateStoreConnectionsPanel } from './StateStoreConnectionsPanel'

const stores = [
  { id: 'a1', name: 'statestore', type: 'state.redis', source: 'auto', path: '/x/a.yaml', active: true, connection: 'localhost:6379' },
  { id: 'm1', name: 'orders-pg', type: 'state.postgresql', source: 'manual', path: '', active: false, connection: 'host=db' },
]

describe('StateStoreConnectionsPanel', () => {
  it('shows auto rows read-only and manual rows with actions', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json(stores)))
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByText('statestore')).toBeInTheDocument())
    expect(screen.getByText('orders-pg')).toBeInTheDocument()
    // ACTIVE badge on the active auto store.
    expect(screen.getByText(/active/i)).toBeInTheDocument()
    // Manual row has edit + delete; auto row does not.
    expect(screen.getByRole('button', { name: /edit orders-pg/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit statestore/i })).not.toBeInTheDocument()
    // Add button present.
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the panel**

Create `web/src/components/StateStoreConnectionsPanel.tsx`:

```tsx
import { useState } from 'react'
import { useStateStores } from '../hooks/useWorkflows'
import { useStoreMutations } from '../hooks/useStoreMutations'
import { StateStoreConnectionDialog } from './StateStoreConnectionDialog'
import { Modal } from './Modal'
import { storeTypeLabel } from '../lib/storeTypes'
import type { StateStore } from '../types/workflow'

export function StateStoreConnectionsPanel() {
  const { data: stores } = useStateStores()
  const { deleteStore } = useStoreMutations()

  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; initial?: StateStore } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StateStore | null>(null)

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: 13 }}>State store connections</b>
        <button className="btn primary" onClick={() => setDialog({ mode: 'add' })}>+ Add connection</button>
      </div>

      {(stores ?? []).length === 0 && <p className="hint">No state store connections yet.</p>}

      {(stores ?? []).map((s) => (
        <div
          key={s.id}
          className="field-row"
          style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--line-soft)' }}
        >
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <b style={{ fontSize: 12.5 }}>{s.name}</b>
            <span className="chip">{storeTypeLabel(s.type)}</span>
            {s.connection && <span className="chip">{s.connection}</span>}
            <span className="pill">{s.source}</span>
            {s.active && <span className="pill" style={{ color: 'var(--done-fg)' }}>ACTIVE</span>}
          </span>
          {s.source === 'manual' && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn ghost" aria-label={`edit ${s.name}`} onClick={() => setDialog({ mode: 'edit', initial: s })}>Edit</button>
              <button className="btn danger" aria-label={`delete ${s.name}`} onClick={() => setPendingDelete(s)}>Delete</button>
            </span>
          )}
        </div>
      ))}

      {/* Mount the dialog only while open, so the component catalog isn't
          fetched on every Components-page load — only when Add/Edit is used. */}
      {dialog && (
        <StateStoreConnectionDialog
          open
          mode={dialog.mode}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
        />
      )}

      <Modal open={pendingDelete !== null} title="Delete connection?" onClose={() => setPendingDelete(null)}>
        <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 14 }}>
          Remove the connection <b>{pendingDelete?.name}</b>? This only removes it from the dashboard registry.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setPendingDelete(null)}>Cancel</button>
          <button
            className="btn danger"
            onClick={async () => {
              if (pendingDelete) await deleteStore.mutateAsync(pendingDelete.id)
              setPendingDelete(null)
            }}
          >Delete</button>
        </div>
      </Modal>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run build`

```bash
git add web/src/components/StateStoreConnectionsPanel.tsx web/src/components/StateStoreConnectionsPanel.test.tsx
git commit -m "feat(web): state store connections panel (list/add/edit/delete)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Place the panel on the Components page

**Files:**
- Modify: `web/src/pages/ResourceList.tsx`
- Test: `web/src/pages/ResourceList.test.tsx`

**Interfaces:**
- Consumes: `StateStoreConnectionsPanel`.
- Produces: the panel renders above the master-detail on the Components page (`kind === 'component'`) in every render state; never on Configurations.

The file already has helpers `renderComponents(entry)` and `renderConfigurations(entry)` and a `describe('ResourceList kind=component', ...)` block. Because the panel calls `/api/statestores` on every component render and MSW is configured with `onUnhandledRequest: 'error'`, **every** component-kind test now needs that endpoint mocked. Add a `beforeEach` to the existing component `describe` block (this covers all existing component tests too):

```tsx
import { beforeEach } from 'vitest'

describe('ResourceList kind=component', () => {
  beforeEach(() => {
    // The State store connections panel fetches this on every component render.
    server.use(http.get('/api/statestores', () => HttpResponse.json([])))
  })
  // …existing tests unchanged…
```

Then add this new test inside that same `describe` block:

```tsx
  it('shows the state store connections panel on components', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([])),
    )
    renderComponents()
    expect(await screen.findByText('State store connections')).toBeInTheDocument()
  })
```

And add a test for the negative case inside the `describe('ResourceList kind=configuration', ...)` block (configurations must NOT render the panel — and configuration renders don't mock `/api/statestores`, which also proves the panel never fires there):

```tsx
  it('does not show the connection panel on configurations', async () => {
    server.use(http.get('/api/resources', () => HttpResponse.json([])))
    renderConfigurations()
    // Give the page a tick to settle, then assert the panel is absent.
    await screen.findByRole('heading', { name: /configurations/i })
    expect(screen.queryByText('State store connections')).not.toBeInTheDocument()
  })
```

> Confirm the exact name of the configuration `describe` block and its existing `/api/resources` mock shape; match them. If a configuration test would now fire `/api/statestores`, that means the `kind` guard in Step 3 is missing — fix the guard, do not mock the endpoint for configurations.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/pages/ResourceList.test.tsx`
Expected: FAIL — "State store connections" not found on the component render.

- [ ] **Step 3: Render the panel for components**

In `web/src/pages/ResourceList.tsx`, add the import:

```tsx
import { StateStoreConnectionsPanel } from '../components/StateStoreConnectionsPanel'
```

The component has three `return` branches (loading, empty, normal), each rendering `<div className="page"><div className="phead">…</div>…`. In **each** branch, insert the panel immediately after the closing `</div>` of `phead` and before the body, guarded by kind:

```tsx
        {kind === 'component' && <StateStoreConnectionsPanel />}
```

For example, the normal branch becomes:

```tsx
  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>{title}</h1>
          <div className="sub">{sub}</div>
        </div>
      </div>
      {kind === 'component' && <StateStoreConnectionsPanel />}
      <div className="md">
        {/* …unchanged… */}
      </div>
    </div>
  )
```

Apply the same one-line insertion in the loading branch (after `phead`, before `<p className="muted">Loading…</p>`) and the empty branch (after `phead`, before `<div className="md">`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/ResourceList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full web suite + typecheck**

Run: `npm test && npm run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/ResourceList.tsx web/src/pages/ResourceList.test.tsx
git commit -m "feat(web): mount connection manager panel on Components page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Backend: `go build ./... && go test -tags unit -race ./... && go test -tags integration ./...` — all green.
- [ ] Web: `cd web && npm test && npm run build` — all green.
- [ ] Manual smoke (optional, via the verify skill): start the dashboard, open Components, add a redis connection, confirm it appears, edit it, delete it; confirm it becomes selectable on the Workflows store selector.
- [ ] Confirm `web/dist/index.html` and `web/package-lock.json` remain uncommitted/untouched.
