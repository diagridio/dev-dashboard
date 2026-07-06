//go:build unit

package cmd

import (
	"os"
	"path/filepath"
	"testing"
	"time"

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
	require.NotEmpty(t, byName["statestore"].ID, "every entry carries a stable id")
	require.Equal(t, "host=localhost dbname=orders user=u password=p", byName["my-pg"].Metadata["connectionString"])
	require.Equal(t, SourceManual, byName["my-pg"].Source)
	require.NotEmpty(t, byName["my-pg"].ID)
}

func TestRegistry_StableIDAcrossReload(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Source: SourceAuto, Path: "/a/b/statestore.yaml"}))
	idBefore := r.List()[0].ID
	require.NotEmpty(t, idBefore)

	// The id is deterministic across save -> LoadRegistry.
	idAfter := LoadRegistry(home).List()[0].ID
	require.Equal(t, idBefore, idAfter, "id must be stable across reload")

	// And re-discovering the same path yields the same id (upsert dedups).
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s-renamed", Type: "state.sqlite", Source: SourceAuto, Path: "/a/b/statestore.yaml"}))
	require.Len(t, r.List(), 1)
	require.Equal(t, idBefore, r.List()[0].ID)
}

func TestRegistry_SameNameDifferentPathsGetDistinctIDs(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)

	// Two auto entries with the SAME name but DIFFERENT paths (e.g. the store
	// named "statestore" in two different projects). Both must persist with
	// distinct ids.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.redis", Source: SourceAuto, Path: "/projA/statestore.yaml"}))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.sqlite", Source: SourceAuto, Path: "/projB/statestore.yaml"}))

	got := r.List()
	require.Len(t, got, 2, "same name + different paths must both persist")
	require.NotEqual(t, got[0].ID, got[1].ID, "distinct paths get distinct ids")
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

func TestRegistry_UpsertAutoIdenticalEntrySkipsSave(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	e := ConnEntry{Name: "s", Type: "state.redis", Source: SourceAuto, Path: "/a/b/statestore.yaml"}
	require.NoError(t, r.UpsertAuto(e))

	// Plant sentinel bytes in the file: if the identical upsert below rewrites
	// it, the sentinel disappears. (The registry never re-reads the file, so the
	// sentinel is invisible to it.)
	sentinel := []byte("# sentinel: must survive a no-op upsert\n")
	require.NoError(t, os.WriteFile(registryPath(home), sentinel, 0o600))

	require.NoError(t, r.UpsertAuto(e), "re-upserting an identical entry must succeed")
	got, err := os.ReadFile(registryPath(home))
	require.NoError(t, err)
	require.Equal(t, sentinel, got, "an unchanged upsert must not rewrite the registry file")

	// A genuinely changed entry still persists.
	e.Type = "state.sqlite"
	require.NoError(t, r.UpsertAuto(e))
	got, err = os.ReadFile(registryPath(home))
	require.NoError(t, err)
	require.NotEqual(t, sentinel, got, "a changed upsert must rewrite the registry file")
	require.Equal(t, "state.sqlite", LoadRegistry(home).List()[0].Type)
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

	pgID := r.List()[0].ID
	require.NotEmpty(t, pgID)

	// Update an existing manual entry, matched by id.
	_, updateErr := r.Update(ConnEntry{ID: pgID, Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=b"}})
	require.NoError(t, updateErr)
	require.Equal(t, "host=b", r.List()[0].Metadata["connectionString"])

	// Update a missing manual entry (unknown id) errors.
	_, updateMissingErr := r.Update(ConnEntry{ID: "deadbeef0000", Name: "nope", Type: "state.redis", Source: SourceManual})
	require.Error(t, updateMissingErr)

	// Delete works (by id) and persists.
	require.NoError(t, r.Delete(pgID))
	require.Len(t, r.List(), 0)
	require.NoError(t, r.Delete(pgID), "deleting an absent entry is not an error")

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

func TestRegistry_LoadBackfillsMissingID(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".dapr", "dev-dashboard")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	// An older file without an id on its entries.
	doc := "connections:\n" +
		"  - name: legacy\n    type: state.redis\n    source: manual\n    metadata:\n      redisHost: localhost:6379\n" +
		"  - name: legacy-auto\n    type: state.sqlite\n    source: auto\n    path: /a/b/store.yaml\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "connections.yaml"), []byte(doc), 0o600))

	got := LoadRegistry(home).List()
	require.Len(t, got, 2)
	for _, e := range got {
		require.NotEmpty(t, e.ID, "LoadRegistry must backfill a missing id")
	}
	// The backfilled id is the deterministic one (manual keyed by name, auto by path).
	byName := map[string]ConnEntry{}
	for _, e := range got {
		byName[e.Name] = e
	}
	require.Equal(t, entryID(SourceManual, "legacy"), byName["legacy"].ID)
	require.Equal(t, entryID(SourceAuto, normPath("/a/b/store.yaml")), byName["legacy-auto"].ID)
}

func TestRegistry_UpsertAutoNeverDuplicatesManualEmptyPath(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	require.NoError(t, reg.Add(ConnEntry{Name: "m", Type: "state.redis", Source: SourceManual}))
	before := len(reg.List())
	// auto upsert with an empty path must not add a spurious entry alongside the manual one
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "m", Type: "state.redis", Source: SourceAuto}))
	require.Len(t, reg.List(), before, "empty-path auto upsert must not duplicate around a manual entry")
}

func TestRegistry_UpdateRejectsRenameOntoExistingManualName(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	require.NoError(t, r.Add(ConnEntry{Name: "a", Type: "state.redis", Source: SourceManual,
		Metadata: map[string]string{"redisHost": "hostA"}}))
	require.NoError(t, r.Add(ConnEntry{Name: "b", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=b"}}))

	aID := entryID(SourceManual, "a")

	// Renaming a onto b's name must fail like a duplicate Add does.
	_, err := r.Update(ConnEntry{ID: aID, Name: "b", Type: "state.redis", Source: SourceManual,
		Metadata: map[string]string{"redisHost": "hostA"}})
	require.ErrorIs(t, err, os.ErrExist, "rename onto an existing manual name must be rejected")

	// The registry is unchanged: both entries intact with distinct ids.
	assertIntact := func(got []ConnEntry) {
		require.Len(t, got, 2)
		byName := map[string]ConnEntry{}
		for _, e := range got {
			byName[e.Name] = e
		}
		require.Equal(t, entryID(SourceManual, "a"), byName["a"].ID)
		require.Equal(t, "hostA", byName["a"].Metadata["redisHost"])
		require.Equal(t, entryID(SourceManual, "b"), byName["b"].ID)
		require.Equal(t, "host=b", byName["b"].Metadata["connectionString"])
	}
	assertIntact(r.List())
	// And the on-disk file is not corrupted either.
	assertIntact(LoadRegistry(home).List())
}

func TestRegistry_UpdateDuplicateNameErrorIsFriendly(t *testing.T) {
	r := LoadRegistry(t.TempDir())
	require.NoError(t, r.Add(ConnEntry{Name: "a", Type: "state.redis", Source: SourceManual}))
	require.NoError(t, r.Add(ConnEntry{Name: "b", Type: "state.postgresql", Source: SourceManual}))

	// Renaming a onto b must fail with a human-readable message that names the
	// conflicting connection (parity with Add's API-surfaced message) while
	// still satisfying errors.Is(err, os.ErrExist) for programmatic callers.
	_, err := r.Update(ConnEntry{ID: entryID(SourceManual, "a"), Name: "b", Type: "state.redis", Source: SourceManual})
	require.ErrorIs(t, err, os.ErrExist, "wrapped error must still match os.ErrExist")
	require.Contains(t, err.Error(), `"b"`, "message must name the conflicting connection")
	require.Contains(t, err.Error(), "already exists")
}

func TestRegistry_SaveLeavesNoTempLitter(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=a"}}))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Source: SourceAuto, Path: "/a/b/statestore.yaml"}))
	require.NoError(t, r.Delete(entryID(SourceAuto, normPath("/a/b/statestore.yaml"))))

	// After several saves the registry dir contains exactly the registry file —
	// no leftover temp files from the write-then-rename dance.
	ents, err := os.ReadDir(filepath.Dir(registryPath(home)))
	require.NoError(t, err)
	require.Len(t, ents, 1, "registry dir must contain only connections.yaml")
	require.Equal(t, "connections.yaml", ents[0].Name())

	// And the atomically-written content still round-trips through LoadRegistry.
	// The deleted auto entry survives as a dismissed tombstone alongside pg.
	got := LoadRegistry(home).List()
	require.Len(t, got, 2)
	byName := map[string]ConnEntry{}
	for _, e := range got {
		byName[e.Name] = e
	}
	require.Equal(t, "host=a", byName["pg"].Metadata["connectionString"])
	require.False(t, byName["pg"].Dismissed)
	require.True(t, byName["s"].Dismissed, "the deleted auto entry is tombstoned, not removed")
}

func TestRegistry_UpdateRenameToOwnNameSucceeds(t *testing.T) {
	r := LoadRegistry(t.TempDir())
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=a"}}))

	pgID := entryID(SourceManual, "pg")
	// A no-op rename (same name, new metadata) must still succeed.
	newID, err := r.Update(ConnEntry{ID: pgID, Name: "pg", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=b"}})
	require.NoError(t, err)
	require.Equal(t, pgID, newID)
	got := r.List()
	require.Len(t, got, 1)
	require.Equal(t, "host=b", got[0].Metadata["connectionString"])
}

func TestUpdateReturnsNewID(t *testing.T) {
	r := LoadRegistry(t.TempDir())
	require.NoError(t, r.Add(ConnEntry{Name: "old", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}}))

	oldID := entryID(SourceManual, "old")
	newID, err := r.Update(ConnEntry{ID: oldID, Name: "renamed", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}})
	require.NoError(t, err)
	require.Equal(t, entryID(SourceManual, "renamed"), newID)
	require.NotEqual(t, oldID, newID)
}

// tickClock returns a fake clock advancing one second per call.
func tickClock(start time.Time) func() time.Time {
	t := start
	return func() time.Time { t = t.Add(time.Second); return t }
}

func entryByName(t *testing.T, r *ConnRegistry, name string) ConnEntry {
	t.Helper()
	for _, e := range r.List() {
		if e.Name == name {
			return e
		}
	}
	t.Fatalf("entry %q not found", name)
	return ConnEntry{}
}

func TestRegistry_UpdatedAtStampedAndBumped(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	r.now = tickClock(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))

	// Add stamps a manual entry.
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql",
		Metadata: map[string]string{"connectionString": "host=h"}}))
	manualAt := entryByName(t, r, "pg").UpdatedAt
	require.False(t, manualAt.IsZero(), "Add must stamp updatedAt")

	// UpsertAuto stamps a new auto entry.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	autoAt := entryByName(t, r, "s").UpdatedAt
	require.False(t, autoAt.IsZero(), "UpsertAuto must stamp a new entry")

	// A no-op upsert (identical fields) must NOT bump the timestamp.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.True(t, entryByName(t, r, "s").UpdatedAt.Equal(autoAt), "no-op upsert must not bump updatedAt")

	// A changed upsert must bump it.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.sqlite", Path: "/a/statestore.yaml"}))
	require.True(t, entryByName(t, r, "s").UpdatedAt.After(autoAt), "changed upsert must bump updatedAt")

	// Update bumps the manual entry.
	_, err := r.Update(ConnEntry{ID: entryByName(t, r, "pg").ID, Name: "pg", Type: "state.postgresql",
		Metadata: map[string]string{"connectionString": "host=h2"}})
	require.NoError(t, err)
	require.True(t, entryByName(t, r, "pg").UpdatedAt.After(manualAt), "Update must bump updatedAt")

	// updatedAt survives a reload from disk.
	r2 := LoadRegistry(home)
	require.False(t, entryByName(t, r2, "s").UpdatedAt.IsZero(), "updatedAt must persist")
}

func TestRegistry_DeleteDismissesAutoRemovesManual(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql"}))
	autoID := entryByName(t, r, "s").ID
	manualID := entryByName(t, r, "pg").ID

	// Manual: removed outright.
	require.NoError(t, r.Delete(manualID))
	require.Len(t, r.List(), 1)

	// Auto: kept, marked dismissed — durable across reload.
	require.NoError(t, r.Delete(autoID))
	require.Len(t, r.List(), 1, "auto entry is tombstoned, not removed")
	require.True(t, r.List()[0].Dismissed)
	require.True(t, LoadRegistry(home).List()[0].Dismissed, "tombstone must persist")

	// UpsertAuto keeps a dismissed entry current but preserves the tombstone.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s2", Type: "state.sqlite", Path: "/a/statestore.yaml"}))
	got := r.List()[0]
	require.Equal(t, "s2", got.Name)
	require.True(t, got.Dismissed, "upsert must not resurrect a dismissed entry")
}

func TestRegistry_UndismissByPath(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	r.now = tickClock(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.NoError(t, r.Delete(r.List()[0].ID))
	dismissedAt := r.List()[0].UpdatedAt
	require.True(t, r.List()[0].Dismissed)

	// Non-matching path: no-op.
	require.NoError(t, r.Undismiss("/other/path.yaml"))
	require.True(t, r.List()[0].Dismissed)

	// Matching path clears the tombstone, bumps updatedAt, and persists.
	require.NoError(t, r.Undismiss("/a/statestore.yaml"))
	require.False(t, r.List()[0].Dismissed)
	require.True(t, r.List()[0].UpdatedAt.After(dismissedAt), "undismiss counts as recent activity")
	require.False(t, LoadRegistry(home).List()[0].Dismissed)
}
