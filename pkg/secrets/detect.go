package secrets

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"sigs.k8s.io/yaml"
)

// yamlDocSeparator matches a YAML document separator line ("---").
// (pkg/resources and pkg/statestore each carry their own copy; this package
// stays isolated rather than introducing a shared YAML utility package.)
var yamlDocSeparator = regexp.MustCompile(`(?m)^---\s*$`)

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

type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Metadata []struct {
			Name         string `json:"name"`
			Value        string `json:"value"`
			EnvRef       string `json:"envRef"`
			SecretKeyRef struct {
				Name string `json:"name"`
				Key  string `json:"key"`
			} `json:"secretKeyRef"`
		} `json:"metadata"`
	} `json:"spec"`
	Auth struct {
		SecretStore string `json:"secretStore"`
	} `json:"auth"`
}

// DetectStores walks the given files or directories and returns every
// secret-store component found, including unsupported types (so a reference to
// one can report store-unsupported rather than store-not-found).
func DetectStores(paths []string) []Store {
	var out []Store
	seen := map[string]bool{}
	for _, p := range paths {
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
				var rc rawComponent
				if err := yaml.Unmarshal(doc, &rc); err != nil {
					continue
				}
				if rc.Kind != "Component" || !IsSecretStoreType(rc.Spec.Type) {
					continue
				}
				props := make(map[string]string, len(rc.Spec.Metadata))
				for _, m := range rc.Spec.Metadata {
					props[m.Name] = m.Value
				}
				out = append(out, Store{
					Name: rc.Metadata.Name, Type: rc.Spec.Type,
					Path: absPath, Properties: props,
				})
			}
			return nil
		})
	}
	return out
}
