package resources

import (
	"context"
	"sort"
	"strconv"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
)

// SecretRefStatus is one component metadata field that draws its value from a
// secret reference, with the outcome of resolving it. It never carries the
// value itself — see the reveal endpoint in pkg/server.
type SecretRefStatus struct {
	Field  string `json:"field"`
	Kind   string `json:"kind"`
	Store  string `json:"store,omitempty"`
	Name   string `json:"name,omitempty"`
	Key    string `json:"key,omitempty"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// SecretStoreInfo describes a local secret-store component for its detail pane.
// Keys are names only.
type SecretStoreInfo struct {
	Name            string   `json:"name"`
	Type            string   `json:"type"`
	File            string   `json:"file,omitempty"`
	Prefix          string   `json:"prefix,omitempty"`
	NestedSeparator string   `json:"nestedSeparator,omitempty"`
	MultiValued     bool     `json:"multiValued,omitempty"`
	Keys            []string `json:"keys,omitempty"`
	KeysCapped      bool     `json:"keysCapped,omitempty"`
	InitErr         string   `json:"initErr,omitempty"`
	UsedBy          []string `json:"usedBy,omitempty"`
}

// StatusNotChecked marks a reference whose value daprd reads from its own
// process environment (a local.env store or an envRef). The dashboard only
// sees its own environment, so any resolved/unset/empty verdict would describe
// the wrong process; the UI shows the reference without a status instead.
const StatusNotChecked = "not-checked"

const notCheckedDetail = "read by daprd from its own environment, which the dashboard can't see"

// secretRefsFor resolves every reference declared in doc. Returns nil when the
// document declares none or no resolver is configured.
func (s *service) secretRefsFor(ctx context.Context, doc []byte) []SecretRefStatus {
	if s.secrets == nil {
		return nil
	}
	storeName, refs := secrets.ParseRefs(doc)
	if len(refs) == 0 {
		return nil
	}
	out := make([]SecretRefStatus, 0, len(refs))
	for field, ref := range refs {
		res := s.secrets.Resolve(ctx, storeName, ref)
		status, detail := res.Status, res.Detail
		if res.FromEnv {
			status, detail = StatusNotChecked, notCheckedDetail
		}
		if status == secrets.StatusStoreNotFound {
			if p, ok := s.containerStorePath(storeName); ok {
				status = secrets.StatusStoreUnreadable
				detail = "declared inside container " + p +
					"; its secrets are not readable from this host"
			}
		}
		out = append(out, SecretRefStatus{
			Field: field, Kind: ref.Kind, Store: storeName,
			Name: ref.Name, Key: ref.Key,
			Status: string(status), Detail: detail,
		})
	}
	sortByField(out)
	return out
}

// docFor returns the raw YAML document for the component matching idOrName,
// using the same precedence as Get: ID first, then name; scanned entries
// before extras.
func (s *service) docFor(idOrName string) ([]byte, error) {
	scanned, err := s.scan(KindComponent)
	if err != nil {
		return nil, err
	}
	extras := s.extraByKind(KindComponent)
	for _, r := range scanned {
		if r.ID == idOrName {
			return r.doc, nil
		}
	}
	for _, r := range extras {
		if r.ID == idOrName {
			return r.doc, nil
		}
	}
	for _, r := range scanned {
		if r.Name == idOrName {
			return r.doc, nil
		}
	}
	for _, r := range extras {
		if r.Name == idOrName {
			return r.doc, nil
		}
	}
	return nil, ErrNotFound
}

// RevealSecret returns the resolved value of the secret reference declared on
// idOrName's field. It is the only method in this package that returns secret
// material; every other path (SecretRefStatus) stops at status/detail.
func (s *service) RevealSecret(ctx context.Context, idOrName, field string) (string, error) {
	if s.secrets == nil {
		return "", ErrNoSecretValue
	}
	doc, err := s.docFor(idOrName)
	if err != nil {
		return "", err
	}
	storeName, refs := secrets.ParseRefs(doc)
	ref, ok := refs[field]
	if !ok {
		return "", ErrNoSecretValue
	}
	res := s.secrets.Resolve(ctx, storeName, ref)
	// A FromEnv value is the dashboard's own, not necessarily daprd's.
	if res.Status != secrets.StatusResolved || res.FromEnv {
		return "", ErrNoSecretValue
	}
	return res.Value, nil
}

// containerStorePath returns the display path of an extras-provided secret
// store with the given name. Extras carry a "<container>:<in-container-path>"
// display path, so the host filesystem has no copy of the store's data.
func (s *service) containerStorePath(storeName string) (string, bool) {
	for _, r := range s.extraByKind(KindComponent) {
		if r.Name == storeName && secrets.IsSecretStoreType(r.Type) {
			return r.Path, true
		}
	}
	return "", false
}

// secretStoreInfoFor builds the detail-pane payload for a secret-store
// component, including which components reference it.
func (s *service) secretStoreInfoFor(ctx context.Context, r Resource) *SecretStoreInfo {
	if s.secrets == nil || !secrets.IsSecretStoreType(r.Type) {
		return nil
	}
	var st secrets.Store
	for _, candidate := range s.secrets.Stores(ctx) {
		if candidate.Name == r.Name {
			st = candidate
			break
		}
	}
	// A component can declare any secretstores.* type (DetectStores deliberately
	// includes unsupported ones so a reference to one reports store-unsupported
	// rather than store-not-found), but only local.file/local.env are ever
	// actually read. Without this check a secretstores.hashicorp.vault or
	// secretstores.azure.keyvault component would get a non-nil SecretStoreInfo
	// with a misleading "Secrets file: —" / "Keys: No keys found." pane, telling
	// the user their vault is empty when the truth is it was never read.
	if st.Name == "" || !st.Supported() {
		return nil
	}
	info := &SecretStoreInfo{
		Name: st.Name, Type: st.Type, File: st.File,
		Prefix: st.Properties["prefix"], InitErr: st.InitErr,
	}
	if st.Type == secrets.TypeFile {
		info.NestedSeparator = st.Properties["nestedSeparator"]
		if info.NestedSeparator == "" {
			// contrib's local/file store defaults to ":" when unset.
			info.NestedSeparator = ":"
		}
		info.MultiValued, _ = strconv.ParseBool(st.Properties["multiValued"])
	}
	info.Keys, info.KeysCapped, _ = s.secrets.KeyNames(ctx, r.Name)
	info.UsedBy = s.usedBy(ctx, r.Name)
	return info
}

// usedBy returns the names of components whose auth.secretStore is storeName.
func (s *service) usedBy(ctx context.Context, storeName string) []string {
	scanned, err := s.scan(KindComponent)
	if err != nil {
		return nil
	}
	all := append(scanned, s.extraByKind(KindComponent)...)
	var out []string
	seen := map[string]bool{}
	for _, r := range all {
		declared, refs := secrets.ParseRefs(r.doc)
		if declared == storeName && len(refs) > 0 && !seen[r.Name] {
			seen[r.Name] = true
			out = append(out, r.Name)
		}
	}
	sortStrings(out)
	return out
}

func sortByField(in []SecretRefStatus) {
	sort.Slice(in, func(i, j int) bool { return in[i].Field < in[j].Field })
}

func sortStrings(in []string) { sort.Strings(in) }
