package statestore

import (
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Version  string `json:"version"`
		Metadata []struct {
			Name         string `json:"name"`
			Value        string `json:"value"`
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

// Detect finds state-store components under the given files or directories.
func Detect(paths []string) ([]Component, error) {
	var out []Component
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
			var rc rawComponent
			if err := yaml.Unmarshal(data, &rc); err != nil {
				return nil
			}
			if rc.Kind != "Component" || !strings.HasPrefix(rc.Spec.Type, "state.") {
				return nil
			}
			md := make(map[string]string, len(rc.Spec.Metadata))
			var refs map[string]SecretRef
			for _, m := range rc.Spec.Metadata {
				if m.SecretKeyRef.Name != "" {
					if refs == nil {
						refs = make(map[string]SecretRef)
					}
					refs[m.Name] = SecretRef{Name: m.SecretKeyRef.Name, Key: m.SecretKeyRef.Key}
					continue
				}
				md[m.Name] = m.Value
			}
			absPath, err := filepath.Abs(path)
			if err != nil {
				absPath = path
			}
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true
			out = append(out, Component{
				Name: rc.Metadata.Name, Type: rc.Spec.Type, Version: rc.Spec.Version,
				Metadata: md, SecretRefs: refs, SecretStore: rc.Auth.SecretStore, Path: absPath,
			})
			return nil
		})
	}
	return out, nil
}
