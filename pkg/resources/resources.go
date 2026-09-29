package resources

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"sigs.k8s.io/yaml"
)

// yamlDocSeparator matches a YAML document separator line ("---").
var yamlDocSeparator = regexp.MustCompile(`(?m)^---\s*$`)

// splitYAMLDocs splits multi-document YAML content on document separator
// lines, dropping empty or whitespace-only documents.
func splitYAMLDocs(data []byte) [][]byte {
	var docs [][]byte
	for _, doc := range yamlDocSeparator.Split(string(data), -1) {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		docs = append(docs, []byte(doc))
	}
	return docs
}

// Kind identifies the Dapr resource type.
type Kind string

const (
	KindComponent     Kind = "component"
	KindConfiguration Kind = "configuration"
)

// ErrNotFound is returned by Get when no matching resource exists.
var ErrNotFound = errors.New("resource not found")

// ErrNoSecretValue is returned by RevealSecret when the field has no secret
// reference, or the reference does not resolve to a value.
var ErrNoSecretValue = errors.New("no resolved secret value for field")

// Resource describes a single Dapr component or configuration YAML file.
type Resource struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Kind     Kind     `json:"kind"`
	Type     string   `json:"type,omitempty"`
	Version  string   `json:"version,omitempty"`
	Path     string   `json:"path"`
	Raw      string   `json:"raw,omitempty"`
	LoadedBy []string `json:"loadedBy,omitempty"`

	SecretRefs  []SecretRefStatus `json:"secretRefs,omitempty"`
	SecretStore *SecretStoreInfo  `json:"secretStore,omitempty"`

	// doc is the single YAML document this resource was parsed from. It is
	// unexported, so it never reaches the API; secret-reference parsing reads
	// it instead of re-walking the file.
	doc []byte
}

// resourceID derives a stable, URL-safe id for a resource — the entryID
// pattern from cmd/registry.go applied to the name|type|path identity key.
// Distinct files always differ in path, so ids never collide across files.
func resourceID(name, typ, path string) string {
	h := sha256.Sum256([]byte(name + "|" + typ + "|" + path))
	return hex.EncodeToString(h[:])[:12]
}

// Service is the interface for listing and fetching Dapr resources.
type Service interface {
	List(ctx context.Context, kind Kind) ([]Resource, error)
	// Get resolves idOrName as a resource ID first, then as a metadata name
	// (first match) so pre-ID deep links keep working.
	Get(ctx context.Context, kind Kind, idOrName string) (Resource, error)
	// RevealSecret returns the resolved value of a single secret reference on
	// a component. It is the only path by which secret material leaves this
	// package.
	RevealSecret(ctx context.Context, idOrName, field string) (string, error)
}

// rawResource is a minimal struct for parsing YAML resource files.
type rawResource struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type    string `json:"type"`
		Version string `json:"version"`
	} `json:"spec"`
}

type service struct {
	paths   func() []string
	extras  func() []Resource
	secrets secrets.Service
}

// Option configures the resources Service.
type Option func(*service)

// WithSecrets attaches a secret resolver so component resources carry secret
// reference status. Without it, SecretRefs and SecretStore stay empty.
func WithSecrets(svc secrets.Service) Option {
	return func(s *service) { s.secrets = svc }
}

// New returns a Service that scans the paths returned by the provider for
// Dapr resource YAMLs, merged with the extras provider's entries (resources
// that exist outside the host filesystem, e.g. extracted from containers).
// Either provider may be nil. Both are called on every List/Get so callers
// can change sources at runtime.
func New(paths func() []string, extras func() []Resource, opts ...Option) Service {
	if paths == nil {
		paths = func() []string { return nil }
	}
	s := &service{paths: paths, extras: extras}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// kindFromString maps a YAML kind string to a Kind constant.
func kindFromString(s string) (Kind, bool) {
	switch s {
	case "Component":
		return KindComponent, true
	case "Configuration":
		return KindConfiguration, true
	default:
		return "", false
	}
}

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
			doc:     doc,
		})
	}
	return out
}

// scan walks all configured paths and returns resources matching the requested kind.
// Raw is always left empty.
func (s *service) scan(kind Kind) ([]Resource, error) {
	var out []Resource
	seen := map[string]bool{}

	for _, p := range s.paths() {
		_ = filepath.Walk(p, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".yaml" && ext != ".yml" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			absPath, err := filepath.Abs(path)
			if err != nil {
				absPath = path
			}
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true
			for _, doc := range splitYAMLDocs(data) {
				var rr rawResource
				if err := yaml.Unmarshal(doc, &rr); err != nil {
					continue
				}
				k, ok := kindFromString(rr.Kind)
				if !ok || k != kind {
					continue
				}
				out = append(out, Resource{
					ID:      resourceID(rr.Metadata.Name, rr.Spec.Type, absPath),
					Name:    rr.Metadata.Name,
					Kind:    k,
					Type:    rr.Spec.Type,
					Version: rr.Spec.Version,
					Path:    absPath,
					doc:     doc,
				})
			}
			return nil
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

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
	for i := range out {
		if out[i].Kind == KindComponent {
			out[i].SecretRefs = s.secretRefsFor(ctx, out[i].doc)
		}
	}
	return out, nil
}

// enrich attaches secret-reference status and, for secret-store components,
// the store detail payload.
func (s *service) enrich(ctx context.Context, r Resource) Resource {
	if r.Kind != KindComponent {
		return r
	}
	r.SecretRefs = s.secretRefsFor(ctx, r.doc)
	r.SecretStore = s.secretStoreInfoFor(ctx, r)
	return r
}

// Get returns the resource matching idOrName (ID first, then first name
// match). File entries load Raw from disk; extras entries already carry it.
// Returns ErrNotFound if none match.
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
		return s.enrich(ctx, r), nil
	}
	for _, r := range scanned {
		if r.ID == idOrName {
			return withRaw(r)
		}
	}
	for _, r := range extras {
		if r.ID == idOrName {
			return s.enrich(ctx, r), nil
		}
	}
	for _, r := range scanned {
		if r.Name == idOrName {
			return withRaw(r)
		}
	}
	for _, r := range extras {
		if r.Name == idOrName {
			return s.enrich(ctx, r), nil
		}
	}
	return Resource{}, ErrNotFound
}
