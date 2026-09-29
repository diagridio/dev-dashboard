package statestore

import (
	"os"
	"path/filepath"
	"regexp"
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

// rawComponent captures only the fields Detect needs to filter and label a
// component. Secret references themselves (secretKeyRef AND envRef) are
// parsed separately via secrets.ParseRefs against the same YAML document, so
// this struct's own Spec.Metadata entries never need a *Ref field: it only
// has to tell a plain value apart from "this name is a reference, skip it".
type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Version  string `json:"version"`
		Metadata []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"metadata"`
	} `json:"spec"`
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
				if rc.Kind != "Component" || !strings.HasPrefix(rc.Spec.Type, "state.") {
					continue
				}
				// secrets.ParseRefs recognizes both secretKeyRef AND envRef against
				// the same document; using it here (rather than a second local
				// secretKeyRef-only parse) is what makes envRef visible on the
				// state-store path at all — previously only pkg/secrets/pkg/resources
				// saw it, so the Components page reported "resolved" while the state
				// dial silently received an empty credential.
				storeName, parsedRefs := secrets.ParseRefs(doc)
				md := make(map[string]string, len(rc.Spec.Metadata))
				var refs map[string]SecretRef
				for _, m := range rc.Spec.Metadata {
					if _, isRef := parsedRefs[m.Name]; isRef {
						continue
					}
					md[m.Name] = m.Value
				}
				for name, r := range parsedRefs {
					if refs == nil {
						refs = make(map[string]SecretRef)
					}
					refs[name] = SecretRef{Kind: r.Kind, Name: r.Name, Key: r.Key}
				}
				out = append(out, Component{
					Name: rc.Metadata.Name, Type: rc.Spec.Type, Version: rc.Spec.Version,
					Metadata: md, SecretRefs: refs, SecretStore: storeName, Path: absPath,
				})
			}
			return nil
		})
	}
	return out, nil
}
