package statestore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

// SecretStore is a detected local Dapr secret-store component. Only the two
// local dev types are represented: secretstores.local.file and
// secretstores.local.env.
type SecretStore struct {
	Name            string
	Type            string // "secretstores.local.file" | "secretstores.local.env"
	SecretsFile     string // local.file only: resolved absolute path to the JSON file
	NestedSeparator string // local.file only: default ":"
}

type rawSecretStore struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Metadata []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"metadata"`
	} `json:"spec"`
}

// DetectSecretStores finds local secret-store components (local.file / local.env)
// under the given files or directories. Other secret-store types are ignored.
func DetectSecretStores(paths []string) ([]SecretStore, error) {
	var out []SecretStore
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
			var rc rawSecretStore
			if err := yaml.Unmarshal(data, &rc); err != nil {
				return nil
			}
			if rc.Kind != "Component" || !strings.HasPrefix(rc.Spec.Type, "secretstores.local.") {
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

			s := SecretStore{Name: rc.Metadata.Name, Type: rc.Spec.Type, NestedSeparator: ":"}
			for _, m := range rc.Spec.Metadata {
				switch m.Name {
				case "secretsFile":
					sf := m.Value
					if sf != "" && !filepath.IsAbs(sf) {
						sf = filepath.Join(filepath.Dir(absPath), sf)
					}
					s.SecretsFile = sf
				case "nestedSeparator":
					if m.Value != "" {
						s.NestedSeparator = m.Value
					}
				}
			}
			out = append(out, s)
			return nil
		})
	}
	return out, nil
}

// ResolveSecrets returns a copy of c.Metadata with each secretKeyRef entry
// resolved using the secret store named by c.SecretStore. Metadata keys that
// cannot be resolved are returned in unresolved and left out of the map.
func ResolveSecrets(c Component, stores []SecretStore) (resolved map[string]string, unresolved []string) {
	out := make(map[string]string, len(c.Metadata)+len(c.SecretRefs))
	for k, v := range c.Metadata {
		out[k] = v
	}
	if len(c.SecretRefs) == 0 {
		return out, nil
	}
	var store *SecretStore
	for i := range stores {
		if stores[i].Name == c.SecretStore {
			store = &stores[i]
			break
		}
	}
	for metaName, ref := range c.SecretRefs {
		val, ok := resolveOne(store, ref)
		if !ok {
			unresolved = append(unresolved, metaName)
			continue
		}
		out[metaName] = val
	}
	return out, unresolved
}

func resolveOne(store *SecretStore, ref SecretRef) (string, bool) {
	if store == nil {
		return "", false
	}
	switch store.Type {
	case "secretstores.local.env":
		key := ref.Key
		if key == "" {
			key = ref.Name
		}
		v := os.Getenv(key)
		return v, v != ""
	case "secretstores.local.file":
		return resolveFromFile(store.SecretsFile, ref)
	default:
		return "", false
	}
}

func resolveFromFile(file string, ref SecretRef) (string, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	raw, ok := doc[ref.Name]
	if !ok {
		return "", false
	}
	// String form: {"redis-secret":"value"}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, true
	}
	// Nested form: {"redis-secret":{"redis-password":"value"}}
	var nested map[string]string
	if err := json.Unmarshal(raw, &nested); err == nil {
		key := ref.Key
		if key == "" {
			key = ref.Name
		}
		if v, ok := nested[key]; ok {
			return v, true
		}
	}
	return "", false
}
