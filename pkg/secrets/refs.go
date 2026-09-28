package secrets

import "sigs.k8s.io/yaml"

// ParseRefs extracts auth.secretStore and every secret reference from a single
// component YAML document. A metadata entry is a reference when it carries a
// secretKeyRef.name or an envRef; entries with a plain value are skipped.
// Dapr gives secretKeyRef precedence over envRef when both are somehow present.
func ParseRefs(doc []byte) (storeName string, refs map[string]Ref) {
	var rc rawComponent
	if err := yaml.Unmarshal(doc, &rc); err != nil {
		return "", nil
	}
	for _, m := range rc.Spec.Metadata {
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
	return rc.Auth.SecretStore, refs
}
