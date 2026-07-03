package resources

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

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

// Resource describes a single Dapr component or configuration YAML file.
type Resource struct {
	Name     string   `json:"name"`
	Kind     Kind     `json:"kind"`
	Type     string   `json:"type,omitempty"`
	Version  string   `json:"version,omitempty"`
	Path     string   `json:"path"`
	Raw      string   `json:"raw,omitempty"`
	LoadedBy []string `json:"loadedBy,omitempty"`
}

// Service is the interface for listing and fetching Dapr resources.
type Service interface {
	List(ctx context.Context, kind Kind) ([]Resource, error)
	Get(ctx context.Context, kind Kind, name string) (Resource, error)
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
	paths func() []string
}

// New returns a Service that scans the paths returned by the provider for Dapr
// resource YAMLs. The provider is called on every List/Get so callers can change
// the scan locations at runtime.
func New(paths func() []string) Service {
	return &service{paths: paths}
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
					Name:    rr.Metadata.Name,
					Kind:    k,
					Type:    rr.Spec.Type,
					Version: rr.Spec.Version,
					Path:    absPath,
				})
			}
			return nil
		})
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// List returns all resources of the given kind, without Raw content.
func (s *service) List(ctx context.Context, kind Kind) ([]Resource, error) {
	return s.scan(kind)
}

// Get returns the named resource of the given kind, with Raw populated from the file.
// Returns ErrNotFound if no matching resource exists.
func (s *service) Get(ctx context.Context, kind Kind, name string) (Resource, error) {
	resources, err := s.scan(kind)
	if err != nil {
		return Resource{}, err
	}
	for _, r := range resources {
		if r.Name == name {
			data, err := os.ReadFile(r.Path)
			if err != nil {
				return Resource{}, err
			}
			r.Raw = string(data)
			return r, nil
		}
	}
	return Resource{}, ErrNotFound
}
