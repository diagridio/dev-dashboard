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

func TestUpdateReturnsNewID(t *testing.T) {
	r := LoadRegistry(t.TempDir())
	require.NoError(t, r.Add(ConnEntry{Name: "old", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}}))

	oldID := entryID(SourceManual, "old")
	newID, err := r.Update(ConnEntry{ID: oldID, Name: "renamed", Type: "state.redis", Metadata: map[string]string{"redisHost": "h"}})
	require.NoError(t, err)
	require.Equal(t, entryID(SourceManual, "renamed"), newID)
	require.NotEqual(t, oldID, newID)
}
