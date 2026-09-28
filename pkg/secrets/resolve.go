package secrets

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	contribmd "github.com/dapr/components-contrib/metadata"
	"github.com/dapr/components-contrib/secretstores"
	envstore "github.com/dapr/components-contrib/secretstores/local/env"
	filestore "github.com/dapr/components-contrib/secretstores/local/file"
	"github.com/dapr/kit/logger"
)

// cacheTTL bounds how long an initialized store is reused. Combined with the
// size+mtime fingerprint it keeps a same-second edit from sticking.
const cacheTTL = 2 * time.Second

// MaxKeyNames caps how many secret names KeyNames returns. The cap is reported
// to the caller rather than applied silently.
const MaxKeyNames = 200

// contribLogger is contrib's required logger, silenced: these stores log
// warnings we surface through Result.Status instead.
func contribLogger() logger.Logger {
	l := logger.NewLogger("dev-dashboard-secrets")
	l.SetOutputLevel(logger.FatalLevel)
	return l
}

// Service resolves secret references against detected local secret stores.
type Service interface {
	// Stores returns every detected secret-store component, with File and
	// InitErr populated for the local types.
	Stores(ctx context.Context) []Store
	// Resolve looks up ref in the store named storeName. An empty storeName
	// yields StatusStoreNotSpecified — Dapr has no default in standalone mode.
	Resolve(ctx context.Context, storeName string, ref Ref) Result
	// KeyNames returns the store's available secret names (never values).
	// capped reports whether the list was truncated.
	KeyNames(ctx context.Context, storeName string) (names []string, capped bool, err error)
}

type entry struct {
	store   secretstores.SecretStore
	file    string // resolved absolute secretsFile
	initErr string
	fp      string // size+mtime fingerprint of the backing file
	at      time.Time
}

type service struct {
	paths func() []string
	mu    sync.Mutex
	cache map[string]*entry // keyed by store identity (path|name|properties)
}

// New returns a Service scanning the paths returned by the provider on every
// call, so path changes at runtime are picked up without a restart.
func New(paths func() []string) Service {
	if paths == nil {
		paths = func() []string { return nil }
	}
	return &service{paths: paths, cache: map[string]*entry{}}
}

func (s *service) Stores(ctx context.Context) []Store {
	found := DetectStores(s.paths())
	for i := range found {
		if !found[i].Supported() {
			continue
		}
		e := s.open(found[i])
		found[i].File, found[i].InitErr = e.file, e.initErr
	}
	return found
}

// find returns the detected store with the given name.
func (s *service) find(name string) (Store, bool) {
	for _, st := range DetectStores(s.paths()) {
		if st.Name == name {
			return st, true
		}
	}
	return Store{}, false
}

// identity keys the cache on everything that changes a store's behaviour.
func identity(st Store) string {
	parts := make([]string, 0, len(st.Properties)+2)
	parts = append(parts, st.Path, st.Name, st.Type)
	for _, k := range []string{"secretsFile", "nestedSeparator", "multiValued", "prefix"} {
		parts = append(parts, k+"="+st.Properties[k])
	}
	return strings.Join(parts, "|")
}

// fileFingerprint returns a size+mtime stamp for path, or "" when unreadable.
func fileFingerprint(path string) string {
	if path == "" {
		return ""
	}
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d-%d", fi.Size(), fi.ModTime().UnixNano())
}

// resolveSecretsFile turns a possibly-relative secretsFile into an absolute
// path. Candidates, in order: an already-absolute path; the declaring YAML's
// directory; that directory's parent (the common "components/" layout, where
// daprd's own working directory is the app root). The first existing candidate
// wins; when none exist the first candidate is returned so Detail can name it.
func resolveSecretsFile(st Store) string {
	raw := st.Properties["secretsFile"]
	if raw == "" {
		return ""
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	dir := filepath.Dir(st.Path)
	candidates := []string{
		filepath.Join(dir, raw),
		filepath.Join(filepath.Dir(dir), raw),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

// open returns an initialized contrib store for st, reusing the cached one
// while its identity, backing-file fingerprint, and TTL all still hold.
func (s *service) open(st Store) *entry {
	key := identity(st)
	file := resolveSecretsFile(st)
	fp := fileFingerprint(file)

	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.cache[key]; ok && e.fp == fp && time.Since(e.at) < cacheTTL {
		return e
	}

	e := &entry{file: file, fp: fp, at: time.Now()}
	props := map[string]string{}
	for k, v := range st.Properties {
		props[k] = v
	}
	var impl secretstores.SecretStore
	switch st.Type {
	case TypeFile:
		props["secretsFile"] = file
		impl = filestore.NewLocalSecretStore(contribLogger())
	case TypeEnv:
		impl = envstore.NewEnvSecretStore(contribLogger())
	}
	if err := impl.Init(context.Background(), secretstores.Metadata{
		Base: contribmd.Base{Properties: props},
	}); err != nil {
		e.initErr = err.Error()
	} else {
		e.store = impl
	}
	s.cache[key] = e
	return e
}

// contribEnvKeyDenied mirrors components-contrib's local/env
// envSecretStore.isKeyAllowed (secretstores/local/env/env.go) exactly: a key
// (already prefix-applied) is denied when it equals APP_API_TOKEN or starts
// with DAPR_, case-insensitive. contrib's GetSecret never errors on a denied
// key — it silently returns an empty value — so without this pre-check a
// secretKeyRef naming a denied key against a local.env store lands on the
// val == "" branch below and reports StatusEmptyValue, sending the user to
// look for an unset variable Dapr will never read regardless of its value.
//
// This is DELIBERATELY a separate rule from EnvVarAllowed (envref.go), which
// backs the runtime's envRef path and additionally denies names containing a
// space and applies the DAPR_ENV_KEYS allowlist. Those two extra rules are
// not part of contrib's local.env store at all; reusing EnvVarAllowed here
// would make this store resolution stricter than contrib's own store and
// could report forbidden for a key contrib would happily read.
func contribEnvKeyDenied(key string) bool {
	upper := strings.ToUpper(key)
	if upper == "APP_API_TOKEN" {
		return true
	}
	return strings.HasPrefix(upper, "DAPR_")
}

// detailFor describes where a store looks things up, for the UI.
func detailFor(st Store, e *entry, ref Ref) string {
	switch st.Type {
	case TypeFile:
		return "secrets file " + e.file
	case TypeEnv:
		return envDetail(st.Properties["prefix"] + ref.Name)
	}
	return ""
}

func (s *service) Resolve(ctx context.Context, storeName string, ref Ref) Result {
	if ref.Kind == "envRef" {
		return resolveEnvRef(ref)
	}
	if storeName == "" {
		return Result{Status: StatusStoreNotSpecified,
			Detail: "the component declares no auth.secretStore, and standalone Dapr has no default"}
	}
	st, ok := s.find(storeName)
	if !ok {
		return Result{Status: StatusStoreNotFound,
			Detail: fmt.Sprintf("no secret store named %q was found in the scanned resource paths", storeName)}
	}
	if !st.Supported() {
		return Result{Status: StatusStoreUnsupported,
			Detail: fmt.Sprintf("%s is not a local secret store; the dashboard does not read it", st.Type)}
	}
	if st.Type == TypeEnv {
		fullName := st.Properties["prefix"] + ref.Name
		if contribEnvKeyDenied(fullName) {
			return Result{Status: StatusForbidden,
				Detail: "env var " + fullName + " is on components-contrib's local.env store denylist (DAPR_*, APP_API_TOKEN)"}
		}
	}
	e := s.open(st)
	detail := detailFor(st, e, ref)
	if e.initErr != "" || e.store == nil {
		return Result{Status: StatusStoreUnreadable, Detail: detail + ": " + e.initErr}
	}
	resp, err := e.store.GetSecret(ctx, secretstores.GetSecretRequest{Name: ref.Name})
	if err != nil {
		return Result{Status: StatusKeyNotFound, Detail: detail}
	}
	val, ok := resp.Data[ref.EffectiveKey()]
	if !ok {
		return Result{Status: StatusKeyNotFound, Detail: detail}
	}
	if val == "" {
		if st.Type == TypeEnv {
			// contrib's GetSecret is a bare os.Getenv, which reports an unset
			// variable as "". lookupEnv tells the two apart.
			return lookupEnv(st.Properties["prefix"] + ref.Name)
		}
		// Dapr applies a secret only when the value is non-empty.
		return Result{Status: StatusEmptyValue, Detail: detail}
	}
	return Result{Status: StatusResolved, Value: val, Detail: detail}
}

// KeyNames returns the store's available secret names (never their values).
// For local.env a prefix is required: without one, listing would enumerate the
// caller's entire environment, so it returns nil.
func (s *service) KeyNames(ctx context.Context, storeName string) ([]string, bool, error) {
	st, ok := s.find(storeName)
	if !ok {
		return nil, false, fmt.Errorf("no secret store named %q", storeName)
	}
	if !st.Supported() {
		return nil, false, fmt.Errorf("%s is not a local secret store", st.Type)
	}
	if st.Type == TypeEnv && st.Properties["prefix"] == "" {
		return nil, false, nil
	}
	e := s.open(st)
	if e.store == nil {
		return nil, false, fmt.Errorf("secret store %q is unreadable: %s", storeName, e.initErr)
	}
	resp, err := e.store.BulkGetSecret(ctx, secretstores.BulkGetSecretRequest{})
	if err != nil {
		return nil, false, err
	}
	names := make([]string, 0, len(resp.Data))
	for k := range resp.Data {
		names = append(names, k)
	}
	sort.Strings(names)
	if len(names) > MaxKeyNames {
		return names[:MaxKeyNames], true, nil
	}
	return names, false, nil
}
