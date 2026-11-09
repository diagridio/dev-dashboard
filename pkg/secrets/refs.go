package secrets

import "sigs.k8s.io/yaml"

// refEntry is a component metadata item or an HTTPEndpoint header: both name
// a field and carry a plain value, a secretKeyRef or an envRef. The plain
// value is deliberately not decoded, so a non-string value (e.g. `value: 3`)
// cannot make the whole document fail to parse.
type refEntry struct {
	Name         string `json:"name"`
	EnvRef       string `json:"envRef"`
	SecretKeyRef struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	} `json:"secretKeyRef"`
}

type refDoc struct {
	Spec struct {
		Metadata []refEntry `json:"metadata"`
		Headers  []refEntry `json:"headers"`
	} `json:"spec"`
	Auth struct {
		SecretStore string `json:"secretStore"`
	} `json:"auth"`
}

// ParseRefs extracts auth.secretStore and every secret reference from a single
// component or HTTPEndpoint YAML document: component spec.metadata entries and
// HTTPEndpoint spec.headers, keyed by their name. An entry is a reference when
// it carries a secretKeyRef.name or an envRef; entries with a plain value are
// skipped. Dapr gives secretKeyRef precedence over envRef when both are
// somehow present.
func ParseRefs(doc []byte) (storeName string, refs map[string]Ref) {
	var rd refDoc
	if err := yaml.Unmarshal(doc, &rd); err != nil {
		return "", nil
	}
	entries := append(rd.Spec.Metadata, rd.Spec.Headers...)
	for _, m := range entries {
		switch {
		case m.SecretKeyRef.Name != "":
			if refs == nil {
				refs = map[string]Ref{}
			}
			refs[m.Name] = Ref{Kind: "secretKeyRef", Name: m.SecretKeyRef.Name, Key: m.SecretKeyRef.Key}
		case m.EnvRef != "":
			if refs == nil {
				refs = map[string]Ref{}
			}
			refs[m.Name] = Ref{Kind: "envRef", Name: m.EnvRef}
		}
	}
	return rd.Auth.SecretStore, refs
}
