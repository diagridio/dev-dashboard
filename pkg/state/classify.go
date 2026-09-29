package state

import (
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// internalActorPrefix marks the actor types Dapr's runtime creates for
// workflows and activities.
const internalActorPrefix = "dapr.internal."

// Delimiter is the separator Dapr puts between a key's app-id prefix and its
// logical remainder. Exported so the API layer can validate a write's input
// and report the key it composed without restating the rule.
const Delimiter = statestore.KeyDelimiter

// ComposeKey builds the stored key for one app-id prefix and logical key. It
// is the inverse of classify for the two-segment case.
func ComposeKey(appID, key string) string { return appID + Delimiter + key }

// keyParts is a classified state key.
type keyParts struct {
	AppID      string
	LogicalKey string
	Kind       Kind
}

// classify splits a Dapr state key into its prefix, its logical remainder, and
// what produced it.
//
// This is a heuristic, not a parse. A Dapr key may itself contain the "||"
// delimiter, in which case an app record with two delimiters in its name is
// classified as actor state and hides behind the UI's "Show internal keys"
// toggle. The alternative — a maintained allowlist of Dapr-internal actor
// types — would rot against Dapr releases, so the misclassification is
// accepted and documented.
//
// Note also that the leading segment is only an app-id under the default
// keyPrefix. A component may set keyPrefix to none, name, or a literal, so
// treat AppID as an opaque prefix that is usually an app-id.
func classify(key string) keyParts {
	segs := strings.Split(key, statestore.KeyDelimiter)
	switch {
	case len(segs) < 2:
		return keyParts{LogicalKey: key, Kind: KindApp}
	case len(segs) == 2:
		return keyParts{AppID: segs[0], LogicalKey: segs[1], Kind: KindApp}
	default:
		kind := KindActor
		if strings.HasPrefix(segs[1], internalActorPrefix) {
			kind = KindWorkflow
		}
		return keyParts{
			AppID:      segs[0],
			LogicalKey: strings.Join(segs[1:], statestore.KeyDelimiter),
			Kind:       kind,
		}
	}
}
