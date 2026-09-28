package secrets

import (
	"os"
	"strings"
)

// EnvVarAllowed mirrors dapr/pkg/runtime/processor/secret.isEnvVarAllowed:
// a denylist of empty names, APP_API_TOKEN, any DAPR_-prefixed name, and any
// name containing a space; then, when DAPR_ENV_KEYS is set (the Kubernetes
// injector sets it), a space-separated allowlist on top.
func EnvVarAllowed(key string) bool {
	upper := strings.ToUpper(key)
	switch {
	case upper == "":
		return false
	case upper == "APP_API_TOKEN":
		return false
	case strings.HasPrefix(upper, "DAPR_"):
		return false
	case strings.Contains(upper, " "):
		return false
	}

	allowlist := os.Getenv("DAPR_ENV_KEYS")
	if allowlist == "" {
		return true
	}
	for _, allowed := range strings.Split(allowlist, " ") {
		if allowed == upper {
			return true
		}
	}
	return false
}

// envDetail names an env var and whose environment it was read from: the
// dashboard's own process, which need not match daprd's.
func envDetail(name string) string {
	return "env var " + name + " in the dashboard's environment"
}

// lookupEnv reads name from the dashboard's environment, telling an unset
// variable (StatusKeyNotFound) apart from one set to "" (StatusEmptyValue).
// Dapr's os.Getenv-based lookups cannot, but the fix differs for the user.
func lookupEnv(name string) Result {
	val, ok := os.LookupEnv(name)
	switch {
	case !ok:
		return Result{Status: StatusKeyNotFound, FromEnv: true,
			Detail: "env var " + name + " is not set in the dashboard's environment"}
	case val == "":
		return Result{Status: StatusEmptyValue, FromEnv: true, Detail: envDetail(name)}
	}
	return Result{Status: StatusResolved, FromEnv: true, Value: val, Detail: envDetail(name)}
}

// resolveEnvRef resolves a spec.metadata[].envRef straight from the
// environment, exactly as the runtime does: no secret store, no prefix.
func resolveEnvRef(ref Ref) Result {
	if !EnvVarAllowed(ref.Name) {
		return Result{Status: StatusForbidden,
			Detail: "env var " + ref.Name + " is on Dapr's denylist (DAPR_*, APP_API_TOKEN, names with spaces)"}
	}
	return lookupEnv(ref.Name)
}
