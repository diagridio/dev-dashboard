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

// etagMatches reports whether an If-None-Match header value matches etag.
// The header may carry a comma-separated list of entity tags, each optionally
// a weak validator (W/"..."), or the wildcard "*".
func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == etag {
			return true
		}
	}
	return false
}

// HandleGetComponents serves the processed component metadata bundle as JSON.
func HandleGetComponents(w http.ResponseWriter, r *http.Request) {
	if match := r.Header.Get("If-None-Match"); match != "" && etagMatches(match, bundleETag) {
		w.Header().Set("ETag", bundleETag)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
	w.Header().Set("ETag", bundleETag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(processedBundle)
}
