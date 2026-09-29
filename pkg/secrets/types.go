// Package secrets resolves Dapr component secret references (secretKeyRef and
// envRef) against local secret stores. Resolution delegates to
// components-contrib's own secretstores/local/{file,env} implementations, so
// nestedSeparator flattening, multiValued, and prefix behave exactly as they
// do in the Dapr runtime rather than being re-derived here.
package secrets

import "strings"

// TypeFile and TypeEnv are the two local secret-store types this package can
// resolve. Any other secretstores.* type is detected and reported, never read.
const (
	TypeFile = "secretstores.local.file"
	TypeEnv  = "secretstores.local.env"
)

// Store is a detected secret-store component.
type Store struct {
	Name       string            // metadata.name
	Type       string            // spec.type
	Path       string            // absolute path of the YAML that declared it
	Properties map[string]string // spec.metadata, verbatim
	File       string            // local.file: the absolute secretsFile actually opened
	InitErr    string            // non-empty when the store could not be initialized
}

// Supported reports whether this package can resolve against the store.
func (s Store) Supported() bool { return s.Type == TypeFile || s.Type == TypeEnv }

// Ref is a single secret reference from a component's spec.metadata entry.
type Ref struct {
	Kind string // "secretKeyRef" | "envRef"
	Name string // secret name, or the env var name for envRef
	Key  string // "" means: fall back to Name
}

// EffectiveKey is the key actually looked up. Dapr falls back to the secret
// name when secretKeyRef.key is omitted.
func (r Ref) EffectiveKey() string {
	if r.Key == "" {
		return r.Name
	}
	return r.Key
}

// Status is the outcome of resolving one reference.
type Status string

const (
	StatusResolved          Status = "resolved"
	StatusStoreNotSpecified Status = "store-not-specified"
	StatusStoreNotFound     Status = "store-not-found"
	StatusStoreUnsupported  Status = "store-unsupported"
	StatusStoreUnreadable   Status = "store-unreadable"
	StatusKeyNotFound       Status = "key-not-found"
	StatusEmptyValue        Status = "empty-value"
	StatusForbidden         Status = "forbidden"
)

// Result is the outcome of one Resolve call. Value is populated for callers on
// the reveal path only; it must never be serialized into a list response.
type Result struct {
	Status Status
	Value  string
	Detail string // human-facing: the env var name or absolute file path tried
	// FromEnv reports that the outcome depends on what the dashboard's own
	// process environment contains. daprd reads its own environment, which
	// need not match, so such an outcome says nothing about daprd.
	FromEnv bool
}

// IsSecretStoreType reports whether a component type declares a secret store.
func IsSecretStoreType(t string) bool { return strings.HasPrefix(t, "secretstores.") }
