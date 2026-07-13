# Testcontainers Components View + App Detail Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show testcontainers apps' component YAML (extracted from the daprd container via `docker cp`) in the Components view, and fill the empty App-detail fields (App protocol for all sources; App PID/uptime, Container/Session rows, and Paths for testcontainers apps).

**Architecture:** `TestcontainersSource` extracts `--resources-path` YAML from each daprd container as a tar stream (`<runtime> cp <id>:<path> -`), cached per container ID; `pkg/resources` gains an extras provider so extracted entries appear beside file-scanned ones — never touching store detection/election. Metadata gains `appConnectionProperties.protocol`; the app-proc resolver gains a PID lookup; AppDetail renders per-source rows.

**Tech Stack:** Go (`archive/tar`, gopsutil, chi), React/TypeScript (vitest).

**Spec:** `docs/superpowers/specs/2026-07-12-testcontainers-components-appdetail-design.md`
**Branch:** `feat/testcontainers-components` (stacked on `feat/testcontainers-discovery`, PR #60).

## Global Constraints

- Extracted YAML feeds ONLY the resources service — never `reconciler.Paths()` additions of real dirs, never `statestore.Detect`, never store election (a `state.in-memory` + `actorStateStore:true` component would win the election and break other apps' workflow views).
- Extraction caps: 32 files, 1 MiB per file; only regular `.yaml`/`.yml` tar members.
- Extract once per container ID; evict cache entries for containers gone from the scan; extraction failure logs once per container and yields no entries.
- Display paths are container-prefixed: `<containerName>:<inContainerPath>` (e.g. `crazy_lamport:/dapr-resources/kvstore.yaml`).
- Aspire rendering is explicitly untouched; CLI PID row stays for standalone; compose rows unchanged. Metrics port stays a placeholder.
- Go test packages use `//go:build unit` tags where neighbors do — run `go test ./... -tags "unit integration"`.
- Vitest does NOT typecheck: any `.ts`/`.tsx` change requires `cd web && npx tsc -b`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Tar → YAML extraction helper

**Files:**
- Create: `pkg/discovery/tar_extract.go`
- Test: `pkg/discovery/tar_extract_test.go`

**Interfaces:**
- Produces: `extractYAMLFromTar(tarBytes []byte) (map[string][]byte, error)` — keys are the tar member names cleaned to slash paths WITHOUT a leading `./` or the top-level directory prefix stripped? No: keys are `path.Clean("/" + name)` of each member (absolute-style container paths are NOT reconstructable from the tar alone, so keys are the member paths as recorded, cleaned; the caller joins them onto the container dir). Values are file contents. Caps: `maxExtractFiles = 32`, `maxExtractFileSize = 1 << 20`.

- [ ] **Step 1: Write the failing test**

Create `pkg/discovery/tar_extract_test.go`:

```go
//go:build unit

package discovery

import (
	"archive/tar"
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// buildTar assembles an in-memory tar the way `docker cp <id>:/dir -` does:
// a top-level directory entry followed by its files.
func buildTar(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	require.NoError(t, tw.WriteHeader(&tar.Header{
		Name: "dapr-resources/", Typeflag: tar.TypeDir, Mode: 0o755,
	}))
	for name, content := range entries {
		require.NoError(t, tw.WriteHeader(&tar.Header{
			Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(content)),
		}))
		_, err := tw.Write([]byte(content))
		require.NoError(t, err)
	}
	require.NoError(t, tw.Close())
	return buf.Bytes()
}

func TestExtractYAMLFromTar_KeepsOnlyYAMLFiles(t *testing.T) {
	data := buildTar(t, map[string]string{
		"dapr-resources/kvstore.yaml": "apiVersion: dapr.io/v1alpha1\nkind: Component\n",
		"dapr-resources/notes.txt":    "not yaml",
		"dapr-resources/cfg.yml":      "kind: Configuration\n",
	})
	files, err := extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Len(t, files, 2)
	require.Contains(t, string(files["dapr-resources/kvstore.yaml"]), "kind: Component")
	require.Contains(t, string(files["dapr-resources/cfg.yml"]), "kind: Configuration")
}

func TestExtractYAMLFromTar_Caps(t *testing.T) {
	big := strings.Repeat("x", maxExtractFileSize+1)
	data := buildTar(t, map[string]string{"dapr-resources/big.yaml": big})
	files, err := extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Empty(t, files) // oversized member skipped, not an error

	many := map[string]string{}
	for i := 0; i < maxExtractFiles+5; i++ {
		many[fmt.Sprintf("dapr-resources/c%03d.yaml", i)] = "kind: Component\n"
	}
	data = buildTar(t, many)
	files, err = extractYAMLFromTar(data)
	require.NoError(t, err)
	require.Len(t, files, maxExtractFiles)
}

func TestExtractYAMLFromTar_GarbageInput(t *testing.T) {
	_, err := extractYAMLFromTar([]byte("this is not a tar archive"))
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -tags unit -run TestExtractYAMLFromTar -v`
Expected: FAIL — `undefined: extractYAMLFromTar`.

- [ ] **Step 3: Implement**

Create `pkg/discovery/tar_extract.go`:

```go
package discovery

import (
	"archive/tar"
	"bytes"
	"io"
	"path"
	"strings"
)

const (
	// maxExtractFiles bounds how many YAML files are read from one
	// container's resources dir; maxExtractFileSize bounds each file.
	maxExtractFiles    = 32
	maxExtractFileSize = 1 << 20 // 1 MiB
)

// extractYAMLFromTar reads a `docker cp <id>:<dir> -` tar stream and returns
// its regular .yaml/.yml members (member path -> content). Oversized members
// and non-YAML files are skipped silently; a corrupt archive errors.
func extractYAMLFromTar(tarBytes []byte) (map[string][]byte, error) {
	tr := tar.NewReader(bytes.NewReader(tarBytes))
	out := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		name := path.Clean(hdr.Name)
		ext := strings.ToLower(path.Ext(name))
		if ext != ".yaml" && ext != ".yml" {
			continue
		}
		if hdr.Size > maxExtractFileSize {
			continue
		}
		if len(out) >= maxExtractFiles {
			break
		}
		data, err := io.ReadAll(io.LimitReader(tr, maxExtractFileSize+1))
		if err != nil {
			return nil, err
		}
		out[name] = data
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -tags unit -run TestExtractYAMLFromTar -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/tar_extract.go pkg/discovery/tar_extract_test.go
git commit -m "feat(discovery): tar extraction helper for container resource YAML

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Container extraction in the scanner + virtual paths

**Files:**
- Modify: `pkg/discovery/scan_testcontainers.go`
- Test: `pkg/discovery/scan_testcontainers_test.go` (add cases)

**Interfaces:**
- Consumes: `extractYAMLFromTar` (Task 1), `containerruntime.Runner.Run(ctx, "cp", "<id>:<dir>", "-")`, existing `TestcontainersSource` fields/cache.
- Produces:
  - `type ExtractedFile struct { Container string; Path string; Content []byte }` — `Container` is the container NAME (display identity), `Path` is the container-internal file path (e.g. `/dapr-resources/kvstore.yaml`).
  - `(s *TestcontainersSource) Files() []ExtractedFile` — snapshot of all extracted files across live containers, stable order (by Container then Path).
  - `ScanResult.ResourcePaths = ["<containerName>:<resourcesPath>"]` and `ScanResult.ConfigPath = "<containerName>:<configPath>"` (when the respective daprd flags are present) — virtual display paths.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/discovery/scan_testcontainers_test.go` (reuse the existing `fakeCRT` and `testcontainersInspectJSON` fixtures; the daprd container in the fixture has ID `28af628017d1`, name `crazy_lamport`, and `--resources-path /dapr-resources`):

```go
// resourcesTar returns a docker-cp-style tar of /dapr-resources with one
// component file. Reuses buildTar from tar_extract_test.go (same package).
func resourcesTar(t *testing.T) []byte {
	t.Helper()
	return buildTar(t, map[string]string{
		"dapr-resources/kvstore.yaml": "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: kvstore\nspec:\n  type: state.in-memory\n  version: v1\n",
	})
}

func TestTestcontainersScanner_ExtractsResourceFiles(t *testing.T) {
	crt := fakeTestcontainersRunner(t)
	crt.responses["cp 28af628017d1:/dapr-resources"] = resourcesTar(t)
	src := NewTestcontainersSource(crt)

	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Equal(t, []string{"crazy_lamport:/dapr-resources"}, results[0].ResourcePaths)

	files := src.Files()
	require.Len(t, files, 1)
	require.Equal(t, "crazy_lamport", files[0].Container)
	require.Equal(t, "/dapr-resources/kvstore.yaml", files[0].Path)
	require.Contains(t, string(files[0].Content), "state.in-memory")
}

func TestTestcontainersScanner_ExtractionCachedAndEvicted(t *testing.T) {
	crt := fakeTestcontainersRunner(t)
	crt.responses["cp 28af628017d1:/dapr-resources"] = resourcesTar(t)
	src := NewTestcontainersSource(crt)
	src.clock = func() time.Time { return time.Now() } // will be swapped below

	// First scan extracts.
	_, err := src.Scanner()()
	require.NoError(t, err)
	cpCalls := 0
	for _, c := range crt.calls {
		if strings.HasPrefix(c, "cp ") {
			cpCalls++
		}
	}
	require.Equal(t, 1, cpCalls)

	// Second scan (cache TTL bypassed by advancing the clock) must NOT re-cp.
	base := time.Now()
	src.clock = func() time.Time { base = base.Add(3 * time.Second); return base }
	_, err = src.Scanner()()
	require.NoError(t, err)
	cpCalls = 0
	for _, c := range crt.calls {
		if strings.HasPrefix(c, "cp ") {
			cpCalls++
		}
	}
	require.Equal(t, 1, cpCalls, "extraction must be cached per container ID")

	// Container disappears -> cache evicted, Files() empty.
	crt.responses["ps -aq"] = []byte("")
	_, err = src.Scanner()()
	require.NoError(t, err)
	require.Empty(t, src.Files())
}

func TestTestcontainersScanner_ExtractionFailureDegrades(t *testing.T) {
	crt := fakeTestcontainersRunner(t)
	crt.errs = map[string]error{"cp 28af628017d1:/dapr-resources": errors.New("no such container")}
	src := NewTestcontainersSource(crt)

	results, err := src.Scanner()()
	require.NoError(t, err) // scan itself still succeeds
	require.Len(t, results, 1)
	require.Empty(t, src.Files())
}
```

Note `fakeCRT.key` joins the first two args, so `cp 28af628017d1:/dapr-resources -` keys as `"cp 28af628017d1:/dapr-resources"` — the map keys above match. Add `errors`, `strings`, `time` imports as needed; if `fakeCRT.errs` is nil-initialized in the existing helper, set the whole map as shown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/discovery/ -tags unit -run TestTestcontainersScanner -v`
Expected: new tests FAIL — `undefined: src.Files` / empty `ResourcePaths`.

- [ ] **Step 3: Implement**

In `pkg/discovery/scan_testcontainers.go`:

1. Add the type and fields:

```go
// ExtractedFile is one YAML file copied out of a daprd container's
// resources dir. Container is the container name (display identity), Path
// the container-internal file path.
type ExtractedFile struct {
	Container string
	Path      string
	Content   []byte
}
```

Add to the `TestcontainersSource` struct (inside the mutex-guarded section):

```go
	// extracted caches per-container-ID resource files (containerID ->
	// files); extractFailed remembers IDs whose extraction already failed
	// so the failure logs once and is not retried every scan.
	extracted     map[string][]ExtractedFile
	extractFailed map[string]bool
```

Initialize both maps in `NewTestcontainersSource`:

```go
func NewTestcontainersSource(run containerruntime.Runner) *TestcontainersSource {
	return &TestcontainersSource{run: run, clock: time.Now,
		extracted: map[string][]ExtractedFile{}, extractFailed: map[string]bool{}}
}
```

2. Add the accessor:

```go
// Files returns the extracted resource files of all currently-scanned
// containers, ordered by container name then path.
func (s *TestcontainersSource) Files() []ExtractedFile {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []ExtractedFile
	for _, files := range s.extracted {
		out = append(out, files...)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Container != out[j].Container {
			return out[i].Container < out[j].Container
		}
		return out[i].Path < out[j].Path
	})
	return out
}
```

3. In `scanOnce`, inside the per-container loop after the `ScanResult` is built (before `results = append`), set the virtual paths and extract:

```go
		if args.ResourcesPath != "" {
			r.ResourcePaths = []string{c.Name + ":" + args.ResourcesPath}
			s.extractResources(ctx, c, args.ResourcesPath)
		}
		if args.ConfigPath != "" {
			r.ConfigPath = c.Name + ":" + args.ConfigPath
		}
```

`scanOnce` runs under `s.mu` (called from `scan`), so `extractResources` accesses the maps without extra locking — but `Files()` also takes `s.mu`; verify `scanOnce` is only ever invoked from `scan` while holding the lock (it is, in the current file) and note it in a comment.

4. Add extraction + eviction:

```go
// extractResources copies the container's resources dir out as a tar stream
// (`cp <id>:<dir> -`, no shell needed — works on distroless images) and
// caches the YAML files per container ID. Runs once per container; a
// failure logs once and is not retried. Caller holds s.mu.
func (s *TestcontainersSource) extractResources(ctx context.Context, c composeContainer, dir string) {
	if _, done := s.extracted[c.ID]; done || s.extractFailed[c.ID] {
		return
	}
	raw, err := s.run.Run(ctx, "cp", c.ID+":"+dir, "-")
	if err != nil {
		logger().Warn("testcontainers resource extraction failed", "container", c.Name, "err", err)
		s.extractFailed[c.ID] = true
		return
	}
	files, err := extractYAMLFromTar(raw)
	if err != nil {
		logger().Warn("testcontainers resource tar parse failed", "container", c.Name, "err", err)
		s.extractFailed[c.ID] = true
		return
	}
	out := make([]ExtractedFile, 0, len(files))
	base := path.Base(strings.TrimSuffix(dir, "/"))
	for name, content := range files {
		// Tar member names are relative to the copied dir's parent (e.g.
		// "dapr-resources/kvstore.yaml"); rebase onto the container path.
		rel := strings.TrimPrefix(name, base+"/")
		out = append(out, ExtractedFile{Container: c.Name, Path: dir + "/" + rel, Content: content})
	}
	s.extracted[c.ID] = out
}
```

At the end of `scanOnce` (after the loop), evict departed containers:

```go
	// Evict extraction cache entries for containers gone from this scan.
	live := map[string]bool{}
	for _, c := range containers {
		live[c.ID] = true
	}
	for id := range s.extracted {
		if !live[id] {
			delete(s.extracted, id)
		}
	}
	for id := range s.extractFailed {
		if !live[id] {
			delete(s.extractFailed, id)
		}
	}
```

Add imports: `path`, `sort` (and keep existing).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -tags unit`
Expected: PASS (all, including pre-existing scanner tests — they set no `cp` response, so extraction fails once and degrades, which must not break them; if a pre-existing test asserts exact `crt.calls`, update its expectation to include the one `cp` call).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/scan_testcontainers.go pkg/discovery/scan_testcontainers_test.go
git commit -m "feat(discovery): extract testcontainers resource YAML; virtual resource paths

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Resources extras provider

**Files:**
- Modify: `pkg/resources/resources.go`
- Modify: `cmd/serve.go:130` (the `resources.New(rc.Paths)` call — add `nil` extras for now)
- Test: `pkg/resources/resources_test.go` (add cases)

**Interfaces:**
- Consumes: nothing new (self-contained; Task 5 wires the real provider).
- Produces:
  - `New(paths func() []string, extras func() []Resource) Service` — `extras` may be nil; extras entries are merged after the file scan in both `List` and `Get`.
  - `FromRaw(displayPath string, content []byte) []Resource` — parses multi-doc YAML into fully-populated Resources (ID from name|type|displayPath, `Path: displayPath`, `Raw: string(content)`); unparseable/unknown-kind docs are skipped.
  - `List` strips `Raw` from extras entries (matching file entries); `Get` returns the extras entry with its stored `Raw` and must NOT try to `os.ReadFile` a display path.

- [ ] **Step 1: Write the failing test**

Add to `pkg/resources/resources_test.go` (match the file's build tags and helper style):

```go
func TestExtras_MergedListedAndFetched(t *testing.T) {
	content := []byte("apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: kvstore\nspec:\n  type: state.in-memory\n  version: v1\n  metadata:\n  - name: actorStateStore\n    value: \"true\"\n")
	extras := func() []Resource { return FromRaw("crazy_lamport:/dapr-resources/kvstore.yaml", content) }
	svc := New(func() []string { return nil }, extras)

	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, "kvstore", list[0].Name)
	require.Equal(t, "state.in-memory", list[0].Type)
	require.Equal(t, "v1", list[0].Version)
	require.Equal(t, "crazy_lamport:/dapr-resources/kvstore.yaml", list[0].Path)
	require.Empty(t, list[0].Raw, "List strips Raw")

	got, err := svc.Get(context.Background(), KindComponent, list[0].ID)
	require.NoError(t, err)
	require.Contains(t, got.Raw, "actorStateStore")

	// Name-based lookup works too.
	got, err = svc.Get(context.Background(), KindComponent, "kvstore")
	require.NoError(t, err)
	require.Equal(t, list[0].ID, got.ID)
}

func TestExtras_ConfigurationDocRoutedByKind(t *testing.T) {
	content := []byte("kind: Component\nmetadata:\n  name: a\nspec:\n  type: state.in-memory\n---\nkind: Configuration\nmetadata:\n  name: cfg\n")
	extras := func() []Resource { return FromRaw("c1:/res/multi.yaml", content) }
	svc := New(func() []string { return nil }, extras)

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "cfg", cfgs[0].Name)
}

func TestExtras_NilProviderKeepsFileBehavior(t *testing.T) {
	svc := New(func() []string { return nil }, nil)
	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Empty(t, list)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/resources/ -v -run TestExtras` (add `-tags unit` if the package's tests carry the tag)
Expected: FAIL — `New` has wrong arity / `undefined: FromRaw`.

- [ ] **Step 3: Implement**

In `pkg/resources/resources.go`:

1. Extend the service:

```go
type service struct {
	paths  func() []string
	extras func() []Resource
}

// New returns a Service that scans the paths returned by the provider for
// Dapr resource YAMLs, merged with the extras provider's entries (resources
// that exist outside the host filesystem, e.g. extracted from containers).
// Either provider may be nil. Both are called on every List/Get so callers
// can change sources at runtime.
func New(paths func() []string, extras func() []Resource) Service {
	if paths == nil {
		paths = func() []string { return nil }
	}
	return &service{paths: paths, extras: extras}
}
```

2. Add `FromRaw`:

```go
// FromRaw parses multi-document YAML content into fully-populated Resources
// carrying Raw. displayPath is the entry's Path verbatim (for container
// sources use "<containerName>:<inContainerPath>") and feeds the ID hash,
// so same-named components from different containers stay distinct.
// Unparseable documents and unknown kinds are skipped.
func FromRaw(displayPath string, content []byte) []Resource {
	var out []Resource
	for _, doc := range splitYAMLDocs(content) {
		var rr rawResource
		if err := yaml.Unmarshal(doc, &rr); err != nil {
			continue
		}
		k, ok := kindFromString(rr.Kind)
		if !ok {
			continue
		}
		out = append(out, Resource{
			ID:      resourceID(rr.Metadata.Name, rr.Spec.Type, displayPath),
			Name:    rr.Metadata.Name,
			Kind:    k,
			Type:    rr.Spec.Type,
			Version: rr.Spec.Version,
			Path:    displayPath,
			Raw:     string(content),
		})
	}
	return out
}
```

3. Merge in `List` and `Get` (extras carry Raw; file entries read Raw from disk):

```go
// extraByKind returns the extras entries of the given kind.
func (s *service) extraByKind(kind Kind) []Resource {
	if s.extras == nil {
		return nil
	}
	var out []Resource
	for _, r := range s.extras() {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out
}

// List returns all resources of the given kind, without Raw content.
func (s *service) List(ctx context.Context, kind Kind) ([]Resource, error) {
	out, err := s.scan(kind)
	if err != nil {
		return nil, err
	}
	for _, r := range s.extraByKind(kind) {
		r.Raw = ""
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// Get returns the resource matching idOrName (ID first, then first name
// match). File entries load Raw from disk; extras entries already carry it.
func (s *service) Get(ctx context.Context, kind Kind, idOrName string) (Resource, error) {
	scanned, err := s.scan(kind)
	if err != nil {
		return Resource{}, err
	}
	extras := s.extraByKind(kind)
	withRaw := func(r Resource) (Resource, error) {
		data, err := os.ReadFile(r.Path)
		if err != nil {
			return Resource{}, err
		}
		r.Raw = string(data)
		return r, nil
	}
	for _, r := range scanned {
		if r.ID == idOrName {
			return withRaw(r)
		}
	}
	for _, r := range extras {
		if r.ID == idOrName {
			return r, nil
		}
	}
	for _, r := range scanned {
		if r.Name == idOrName {
			return withRaw(r)
		}
	}
	for _, r := range extras {
		if r.Name == idOrName {
			return r, nil
		}
	}
	return Resource{}, ErrNotFound
}
```

(The old `List` sorted inside `scan`; keep `scan`'s sort — the re-sort in `List` after appending extras keeps the combined order stable. Do NOT remove `scan`'s sort: `Get`'s ID/name precedence relies on deterministic order.)

4. Update the one caller in `cmd/serve.go` line ~130: `Resources: resources.New(rc.Paths)` → `Resources: resources.New(rc.Paths, deps.ExtraResources)`. Since `serveDeps.ExtraResources` doesn't exist until Task 5, for THIS task write `resources.New(rc.Paths, nil)` — Task 5 replaces the `nil`. Also update any `resources.New(` call sites in tests (`grep -rn "resources.New(" --include='*.go'`) to pass `nil`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/resources/ ./cmd/ ./pkg/server/ -tags "unit integration" && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/resources/resources.go pkg/resources/resources_test.go cmd/serve.go
git commit -m "feat(resources): extras provider for non-filesystem resource entries

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: App protocol — metadata + argv fallback

**Files:**
- Modify: `pkg/discovery/metadata.go` (Metadata struct, rawMetadata, FetchMetadata)
- Modify: `pkg/discovery/compose_args.go` (`daprdArgs.AppProtocol`)
- Modify: `pkg/discovery/service.go` (`ScanResult.AppProtocol`, enrich wiring)
- Modify: `pkg/discovery/types.go` (`Instance.AppProtocol`)
- Modify: `pkg/discovery/scan_compose.go` + `pkg/discovery/scan_testcontainers.go` (set `AppProtocol` from parsed args)
- Test: `pkg/discovery/metadata_test.go`, `pkg/discovery/compose_args_test.go`, `pkg/discovery/service_test.go` (add cases)

**Interfaces:**
- Produces: `Metadata.AppProtocol string` (from JSON `appConnectionProperties.protocol`); `daprdArgs.AppProtocol` (from `--app-protocol`); `ScanResult.AppProtocol`; `Instance.AppProtocol` (JSON `appProtocol,omitempty`). Precedence in enrich: metadata value wins when non-empty; scan-result (argv) value is the initial/fallback value.

- [ ] **Step 1: Write the failing tests**

In `pkg/discovery/metadata_test.go`, find the existing FetchMetadata test (it stubs the endpoint with `httptest`); add a case (mirror its style):

```go
func TestFetchMetadata_AppProtocol(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"a","appConnectionProperties":{"port":8080,"protocol":"http","channelAddress":"host.testcontainers.internal"}}`))
	}))
	defer srv.Close()
	md, err := FetchMetadata(context.Background(), srv.Client(), srv.URL)
	require.NoError(t, err)
	require.Equal(t, "http", md.AppProtocol)
}
```

In `pkg/discovery/compose_args_test.go`:

```go
func TestParseDaprdArgs_AppProtocol(t *testing.T) {
	args, ok := parseDaprdArgs([]string{"./daprd", "--app-id", "a", "--app-protocol", "grpc"})
	require.True(t, ok)
	require.Equal(t, "grpc", args.AppProtocol)
}
```

In `pkg/discovery/service_test.go` (extend the existing unreachable-sidecar testcontainers test pattern):

```go
func TestEnrich_AppProtocolFromScanResult(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "a", Source: SourceTestcontainers, AppProtocol: "http",
			DaprdContainerName: "c1",
		}}, nil
	}
	svc := &service{scan: scan}
	out, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, "http", out[0].AppProtocol)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/discovery/ -tags unit -run 'AppProtocol' -v`
Expected: FAIL — unknown fields.

- [ ] **Step 3: Implement**

`pkg/discovery/metadata.go`:
- `Metadata` struct: add `AppProtocol string` (after `CLIPID`).
- `rawMetadata`: add

```go
	AppConnectionProperties struct {
		Protocol string `json:"protocol"`
	} `json:"appConnectionProperties"`
```

- `FetchMetadata` return literal: add `AppProtocol: raw.AppConnectionProperties.Protocol,`.

`pkg/discovery/compose_args.go`:
- `daprdArgs`: add `AppProtocol string`.
- In `parseDaprdArgs`'s result literal: `AppProtocol: flags["app-protocol"],`.

`pkg/discovery/service.go`:
- `ScanResult`: add `AppProtocol string` (near `AppPort`).
- In `enrich`'s `Instance` literal: add `AppProtocol: r.AppProtocol,`.
- After `in.MetadataOK = true` block where other metadata fields are copied (next to `in.RuntimeVersion = md.RuntimeVersion`):

```go
	if md.AppProtocol != "" {
		in.AppProtocol = md.AppProtocol
	}
```

`pkg/discovery/types.go`:
- `Instance`: add `AppProtocol string \`json:"appProtocol,omitempty"\`` (after `AppPort`).

`pkg/discovery/scan_compose.go` (in the `ScanResult` literal): add `AppProtocol: args.AppProtocol,`.
`pkg/discovery/scan_testcontainers.go` (in the `ScanResult` literal): add `AppProtocol: args.AppProtocol,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -tags unit && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/metadata.go pkg/discovery/compose_args.go pkg/discovery/service.go pkg/discovery/types.go pkg/discovery/scan_compose.go pkg/discovery/scan_testcontainers.go pkg/discovery/metadata_test.go pkg/discovery/compose_args_test.go pkg/discovery/service_test.go
git commit -m "feat(discovery): app protocol from metadata with argv fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: App PID + uptime via app-port listener

**Files:**
- Modify: `pkg/discovery/appproc.go` (resolver interface + gopsutil impl)
- Modify: `pkg/discovery/service.go` (testcontainers post-metadata branch)
- Test: `pkg/discovery/service_test.go` (add case; update fakes)

**Interfaces:**
- Consumes: existing `appProcResolver` interface, `service.procStartTime`.
- Produces: `appProcResolver` gains `PIDForPort(port int) (int, bool)`; every in-repo fake implementing the interface gains the method. Testcontainers enrichment sets `Instance.AppPID` and `Instance.AppStartedAt` from the app-port listener when the app is running.

- [ ] **Step 1: Write the failing test**

In `pkg/discovery/service_test.go`, extend `fakeAppProc` (from the Task-4-of-PR-#60 work) with a PID:

```go
type fakeAppProc struct {
	cmd string
	pid int
}

func (f fakeAppProc) CommandForPort(int) (string, bool) { return f.cmd, f.cmd != "" }
func (f fakeAppProc) PIDForPort(int) (int, bool)        { return f.pid, f.pid != 0 }
```

(Update the existing `fakeAppProc` literal uses accordingly — Go fills missing fields with zero values, so existing `fakeAppProc{cmd: ...}` literals keep compiling. Any OTHER type implementing `appProcResolver` in tests — e.g. `fakeAspireResolver` — needs the new method too; give it `func (f fakeAspireResolver) PIDForPort(int) (int, bool) { return 0, false }` adjusted to its receiver.)

Add the test — the sidecar must be reachable so metadata runs, since PID resolution lives in the post-metadata branch (mirror the package's existing httptest metadata stub pattern; if none exists for enrich tests, stub health+metadata):

```go
func TestEnrich_TestcontainersAppPIDAndUptime(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/v1.0/metadata") {
			_, _ = w.Write([]byte(`{"id":"workflow-patterns-app"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent) // healthz
	}))
	defer srv.Close()
	port := portOf(t, srv.URL) // helper: parse the httptest port; add if absent

	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "workflow-patterns-app", Source: SourceTestcontainers,
			AppPort: 8080, HTTPPort: port, SidecarReachable: true,
			DaprdContainerName: "crazy_lamport",
		}}, nil
	}
	started := time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)
	svc := &service{
		scan:     scan,
		client:   srv.Client(),
		appProc:  fakeAppProc{cmd: "/usr/bin/java -jar app.jar", pid: 4242},
		portOpen: func(int) bool { return true },
		procStart: func(pid int) (time.Time, bool) {
			if pid == 4242 {
				return started, true
			}
			return time.Time{}, false
		},
	}
	out, err := svc.List(context.Background())
	require.NoError(t, err)
	in := out[0]
	require.Equal(t, 4242, in.AppPID)
	require.Equal(t, started.Format(time.RFC3339), in.AppStartedAt)
}
```

`portOf` helper if the file lacks one:

```go
func portOf(t *testing.T, rawURL string) int {
	t.Helper()
	u, err := url.Parse(rawURL)
	require.NoError(t, err)
	p, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return p
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -tags unit -run TestEnrich_TestcontainersAppPIDAndUptime -v`
Expected: FAIL — `fakeAppProc` doesn't satisfy the (not-yet-extended) interface, then after interface change: AppPID stays 0.

- [ ] **Step 3: Implement**

`pkg/discovery/appproc.go`:

```go
// appProcResolver resolves the local process listening on a TCP port. It
// isolates the OS-level lookup so it can be faked in tests.
type appProcResolver interface {
	CommandForPort(port int) (string, bool)
	// PIDForPort returns the PID of the port's LISTEN process.
	PIDForPort(port int) (int, bool)
}
```

Add the gopsutil implementation (mirror `CommandForPort`'s loop):

```go
func (gopsutilResolver) PIDForPort(port int) (int, bool) {
	conns, err := gnet.Connections("inet")
	if err != nil {
		return 0, false
	}
	for _, c := range conns {
		if c.Status == "LISTEN" && int(c.Laddr.Port) == port && c.Pid != 0 {
			return int(c.Pid), true
		}
	}
	return 0, false
}
```

`pkg/discovery/service.go` — in the existing testcontainers post-metadata branch (the one that sets `RunTemplate` and returns), before the return:

```go
	if in.Source == SourceTestcontainers {
		// Container sidecar + host app: metadata Extended PIDs/log paths
		// describe the container's own view; daprd logs stream from the
		// container runtime, and the app's stdout belongs to the test process.
		// The app PID comes from the host's app-port listener instead
		// (metadata's appPID, if any, is container-scoped and was just
		// copied over it — override).
		in.AppPID = 0
		if in.AppStatus == StatusRunning && s.appProc != nil && in.AppPort != 0 {
			if pid, ok := s.appProc.PIDForPort(in.AppPort); ok {
				in.AppPID = pid
				if t, ok := s.procStartTime(pid); ok {
					in.AppStartedAt = t.UTC().Format(time.RFC3339)
				}
			}
		}
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
```

Update every other `appProcResolver` implementation in test files to add `PIDForPort` (compile errors point at each; return `(0, false)` unless the test needs a PID).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -tags unit && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/appproc.go pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): resolve testcontainers app PID and uptime from app-port listener

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: cmd wiring + store-isolation guard

**Files:**
- Modify: `cmd/serve.go` (`serveDeps.ExtraResources`; replace Task 3's `nil`)
- Modify: `cmd/root.go` (build the adapter from `tcSrc`, pass through serveDeps)
- Test: `cmd/serve_test.go` or `cmd/root_test.go` (adapter test), plus a store-isolation guard test

**Interfaces:**
- Consumes: `discovery.TestcontainersSource.Files() []discovery.ExtractedFile` (Task 2), `resources.FromRaw(displayPath, content) []resources.Resource` (Task 3).
- Produces: `serveDeps.ExtraResources func() []resources.Resource`; `tcExtraResources(src *discovery.TestcontainersSource) func() []resources.Resource` in cmd.

- [ ] **Step 1: Write the failing tests**

In `cmd/serve_test.go` (or a new focused test in `cmd/root_test.go` — follow whichever file already tests serve wiring helpers):

```go
func TestTCExtraResources_AdaptsExtractedFiles(t *testing.T) {
	// A TestcontainersSource whose fake runner serves one daprd container
	// with a resources tar — reuse the discovery test fixtures via a tiny
	// local stand-in instead: tcExtraResources only needs Files(), so give
	// it a source primed by a fake scan. Simplest honest setup: construct
	// the source against a fake runner exactly as pkg/discovery tests do is
	// not possible from cmd (fakeCRT is package-private), so this test uses
	// a real TestcontainersSource with a nil runner (no files) plus a unit
	// test of the adapter's mapping via FromRaw directly:
	src := discovery.NewTestcontainersSource(nil)
	extras := tcExtraResources(src)
	require.Empty(t, extras()) // nil runner -> no files -> no extras

	// Mapping contract is pinned at the resources level:
	rs := resources.FromRaw("crazy_lamport:/dapr-resources/kvstore.yaml",
		[]byte("kind: Component\nmetadata:\n  name: kvstore\nspec:\n  type: state.in-memory\n"))
	require.Len(t, rs, 1)
	require.Equal(t, "crazy_lamport:/dapr-resources/kvstore.yaml", rs[0].Path)
}

// TestVirtualPathsDoNotFeedStoreDetection guards the spec's isolation rule:
// container-prefixed virtual resource paths must be harmless no-ops for
// state-store detection (they are not host paths).
func TestVirtualPathsDoNotFeedStoreDetection(t *testing.T) {
	comps, err := statestore.Detect([]string{"crazy_lamport:/dapr-resources"})
	require.NoError(t, err)
	require.Empty(t, comps)
}
```

Check `statestore.Detect`'s exact signature before writing (`grep -n "func Detect" pkg/statestore/*.go`) and adjust the call/returns to match.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/ -tags "unit integration" -run 'TCExtraResources|VirtualPaths' -v`
Expected: FAIL — `undefined: tcExtraResources`.

- [ ] **Step 3: Implement**

`cmd/serve.go`:
- Add to `serveDeps` (after `ResourcesPaths`):

```go
	// ExtraResources supplies resource entries that exist outside the host
	// filesystem (testcontainers-extracted component YAML); nil when the
	// testcontainers scanner is disabled (aspire mode, tests).
	ExtraResources func() []resources.Resource
```

- In `assembleOptions`, replace Task 3's `resources.New(rc.Paths, nil)` with `resources.New(rc.Paths, deps.ExtraResources)`.

`cmd/root.go`:
- Add the adapter (near `containerLogStream` in serve.go, or in root.go next to its use — pick serve.go for cohesion with `serveDeps`):

```go
// tcExtraResources adapts the testcontainers scanner's extracted files into
// resources entries with container-prefixed display paths. The entries feed
// ONLY the resources service — never state-store detection or election (an
// extracted in-memory actor store would otherwise win the election).
func tcExtraResources(src *discovery.TestcontainersSource) func() []resources.Resource {
	return func() []resources.Resource {
		var out []resources.Resource
		for _, f := range src.Files() {
			out = append(out, resources.FromRaw(f.Container+":"+f.Path, f.Content)...)
		}
		return out
	}
}
```

- In `runServe`'s `default:` mode case, capture the source and add to the deps: after `tcSrc := discovery.NewTestcontainersSource(crtRunner)`, declare `extraRes = tcExtraResources(tcSrc)` (add `extraRes func() []resources.Resource` to the `var (...)` block at the top of `runServe`, import `pkg/resources`), and pass `ExtraResources: extraRes,` in the `serveDeps` literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/ -tags "unit integration" && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/serve.go cmd/root.go cmd/serve_test.go
git commit -m "feat(cmd): wire testcontainers extracted resources into the resources service

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — protocol, Container/Session rows

**Files:**
- Modify: `web/src/types/api.ts` (`appProtocol?: string` on `AppSummary`)
- Modify: `web/src/pages/AppDetail.tsx` (protocol row; daprd-panel Container row for testcontainers; Session row replacing CLI PID for testcontainers)
- Test: `web/src/pages/AppDetail.test.tsx` (add cases)

**Interfaces:**
- Consumes: backend now emits `appProtocol` and (from PR #60) `testcontainersSession`, `daprdContainerName`.
- Produces: AppDetail renders — for every source: App protocol from `app.appProtocol`; for testcontainers only: daprd panel shows Container (name) instead of daprd PID; app panel shows App PID + Session (first 8 chars, full value in `title`); standalone/compose/aspire rendering unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/pages/AppDetail.test.tsx` (reuse the file's existing render helper and app fixture builder; names below follow the pattern established by the PR #60 testcontainers test in this file):

```tsx
it('renders app protocol when reported', () => {
  renderDetail(makeApp({ appId: 'a', appProtocol: 'http' }))
  expect(screen.getByText('http')).toBeInTheDocument()
})

it('renders Container and Session rows for testcontainers apps', () => {
  renderDetail(makeApp({
    appId: 'workflow-patterns-app',
    source: 'testcontainers',
    daprdContainerName: 'crazy_lamport',
    testcontainersSession: 'efeba7ba-5fdd-4713-ae0c-38f4a462cf46',
    appStatus: 'running',
    daprdStatus: 'running',
  }))
  expect(screen.getByText('crazy_lamport')).toBeInTheDocument()
  expect(screen.getByText('Session')).toBeInTheDocument()
  expect(screen.getByText('efeba7ba')).toBeInTheDocument()
  expect(screen.queryByText('daprd PID')).not.toBeInTheDocument()
  expect(screen.queryByText('CLI PID')).not.toBeInTheDocument()
})

it('keeps CLI PID and daprd PID rows for standalone apps', () => {
  renderDetail(makeApp({ appId: 'a', source: 'standalone' }))
  expect(screen.getByText('CLI PID')).toBeInTheDocument()
  expect(screen.getByText('daprd PID')).toBeInTheDocument()
})
```

(Adapt `renderDetail`/`makeApp` to the file's actual helper names — they exist from prior testcontainers tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL — protocol renders `—`; Session row absent; daprd PID row present for testcontainers. (TS may reject `appProtocol` until api.ts is edited.)

- [ ] **Step 3: Implement**

`web/src/types/api.ts` — on `AppSummary`, next to `appPort`:

```ts
  /** app channel protocol reported by daprd (http, grpc, https, ...) */
  appProtocol?: string
```

`web/src/pages/AppDetail.tsx` (the `isTestcontainers` const exists from PR #60):

1. Protocol row (currently a hardcoded dash):

```tsx
            <div className="kk">App protocol</div>
            <div className="vv mono">{app.appProtocol || <span className="faint">—</span>}</div>
```

2. App panel PID block — the current `isCompose ? (container rows) : (App PID + CLI PID rows)` gains a testcontainers variant inside the else-branch: keep the App PID rows, then:

```tsx
                {isTestcontainers ? (
                  <>
                    <div className="kk">Session</div>
                    <div className="vv mono" title={app.testcontainersSession}>
                      {app.testcontainersSession ? app.testcontainersSession.slice(0, 8) : <span className="faint">—</span>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="kk">CLI PID</div>
                    <div className="vv mono">{app.cliPid || <span className="faint">—</span>}</div>
                  </>
                )}
```

3. Daprd panel — widen the container-row condition from `isCompose ?` to `isCompose || isTestcontainers ?` (the row body already renders `app.daprdContainerName`).

Aspire note: `isTestcontainers` is false for aspire apps, so aspire rendering is untouched — do not add any aspire-specific conditions.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd web && npx vitest run && npx tsc -b`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/api.ts web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): app protocol row; container and session rows for testcontainers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification + live e2e

**Files:** none created (verification only; commit fixes individually if something is broken).

- [ ] **Step 1: Full build and suites**

```bash
go build ./... && go test ./... -tags "unit integration"
cd web && npx vitest run && npx tsc -b && cd ..
make build
```

Expected: everything passes.

- [ ] **Step 2: Live e2e against the Java quickstart**

Start the quickstart in the background (takes 1-3 min; poll `curl -s localhost:8080/actuator/health` for `{"status":"UP"}`):

```bash
cd /Users/marcduiker/dev/dapr/quickstarts/tutorials/workflow/java/child-workflows
mvn spring-boot:test-run
```

Then run the dashboard (`go run . --no-open --port 9095`) and verify (confirm exact API paths against `pkg/server/resources.go` and `pkg/server/apps.go` first):

```bash
# 1. kvstore appears in the Components list with the container-prefixed path
curl -s 'localhost:9095/api/resources?kind=component' | jq '.[] | {name, type, path, loadedBy}'
# expect an entry: kvstore / state.in-memory / crazy_...:/dapr-resources/kvstore.yaml / ["<instanceKey>"]

# 2. Detail carries the full YAML incl. actorStateStore
ID=$(curl -s 'localhost:9095/api/resources?kind=component' | jq -r '.[] | select(.name=="kvstore") | .id')
curl -s "localhost:9095/api/resources/component/$ID" | jq -r '.raw' | grep actorStateStore

# 3. App detail: protocol, JVM PID, uptime, session, virtual paths
curl -s localhost:9095/api/apps | jq '.[] | select(.source=="testcontainers") | {appProtocol, appPid, appStartedAt, testcontainersSession, resourcePaths}'
# expect: http / non-zero PID (a java process) / RFC3339 timestamp / session uuid / ["<container>:/dapr-resources"]

# 4. Workflows still work and the store election is untouched: no store banner
#    change, and if a Redis store is elected it stays elected (check /api/statestores).
curl -s localhost:9095/api/workflows | jq '.items | length'
```

Also verify in the UI if convenient: Components page shows kvstore (read-only, container path), AppDetail shows Uptime ticking, App PID, protocol `http`, Container `crazy_lamport`, Session prefix.

Kill the mvn process and the dashboard afterward; confirm ryuk removed the org.testcontainers containers and no processes remain.

- [ ] **Step 3: Confirm store-election isolation live**

While the quickstart is up: `curl -s localhost:9095/api/statestores | jq` must NOT list kvstore/state.in-memory as a detected or active store entry.

- [ ] **Step 4: Commit any fixes; hand off**

If steps 1-3 surfaced fixes, commit each individually. Then hand off to superpowers:finishing-a-development-branch (PR should target `feat/testcontainers-discovery` if PR #60 is still open, else `main`).

---

## Deferred (documented, deliberately out of scope)

- Extraction for compose containers with unmounted resource dirs.
- Metrics port (placeholder for all sources today).
- Aspire row rendering (dash-only CLI PID row remains).
- Editing extracted (read-only) component entries.
