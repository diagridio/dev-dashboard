package cmd

import (
	"crypto/sha256"
	"encoding/hex"
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

// ConnEntry is one persisted connection in the registry file. ID is a stable,
// deterministic, URL-safe key; the registry, API, ServiceFor, and CRUD address
// entries by ID (two distinct entries may share a Name). auto entries carry a
// Path (re-read + 2a-resolved on connect, no secrets in the file); manual
// entries carry inline Metadata (possibly secrets).
type ConnEntry struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Type     string            `json:"type"`
	Source   string            `json:"source"`
	Path     string            `json:"path,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// entryID derives a deterministic, stable, URL-safe id for an entry. key is the
// normalized path for auto entries and the name for manual entries; the same
// key always yields the same id, so re-discovery upserts and ids survive
// restarts. Auto ids hash the normalized path; manual ids hash "manual:"+name
// so a manual and an auto entry never collide.
func entryID(source, key string) string {
	var h [32]byte
	if source == SourceManual {
		h = sha256.Sum256([]byte("manual:" + key))
	} else {
		h = sha256.Sum256([]byte(key))
	}
	return hex.EncodeToString(h[:])[:12]
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
	// Backfill ids for older files written before ids existed, so the id is
	// always present and deterministic.
	for i := range r.entries {
		if r.entries[i].ID == "" {
			if r.entries[i].Source == SourceManual {
				r.entries[i].ID = entryID(SourceManual, r.entries[i].Name)
			} else {
				r.entries[i].ID = entryID(SourceAuto, normPath(r.entries[i].Path))
			}
		}
	}
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
	key := normPath(e.Path)
	e.ID = entryID(SourceAuto, key)
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && normPath(r.entries[i].Path) == key && key != normPath("") {
			return nil // never overwrite a manual entry
		}
	}
	for i := range r.entries {
		if r.entries[i].Source == SourceAuto && normPath(r.entries[i].Path) == key {
			r.entries[i].ID = e.ID
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
	e.ID = entryID(SourceManual, e.Name)
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

// Update replaces a manual entry matched by ID; errors if none exists. The id
// is recomputed from the (possibly new) name so it stays deterministic.
func (r *ConnRegistry) Update(e ConnEntry) error {
	e.Source = SourceManual
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		if r.entries[i].Source == SourceManual && r.entries[i].ID == e.ID {
			e.ID = entryID(SourceManual, e.Name)
			r.entries[i] = e
			return r.save()
		}
	}
	return os.ErrNotExist
}

// Delete removes any entry (manual or auto) by ID. An absent id is a no-op.
func (r *ConnRegistry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.entries[:0]
	removed := false
	for _, e := range r.entries {
		if e.ID == id {
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
