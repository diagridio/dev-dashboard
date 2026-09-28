package statestore

import (
	"strconv"
	"strings"
)

const (
	KeyDelimiter       = "||"
	SuffixMetadata     = "metadata"
	SuffixCustomStatus = "customStatus"
	HistoryPrefix      = "history-"
)

// WorkflowActorType builds the Dapr workflow actor type for an app.
func WorkflowActorType(namespace, appID string) string {
	return "dapr.internal." + namespace + "." + appID + ".workflow"
}

// InstanceMetaPattern is a KeysLike LIKE pattern matching every instance's
// metadata key for an app ("%" matches the instance-id segment).
func InstanceMetaPattern(namespace, appID string) string {
	return appID + KeyDelimiter + WorkflowActorType(namespace, appID) + KeyDelimiter + "%" + KeyDelimiter + SuffixMetadata
}

// InstancePrefix is the "<appId>||<actorType>||<instanceID>||" prefix.
func InstancePrefix(namespace, appID, instanceID string) string {
	return appID + KeyDelimiter + WorkflowActorType(namespace, appID) + KeyDelimiter + instanceID + KeyDelimiter
}

// InstanceKeyPattern matches every state key belonging to one instance.
func InstanceKeyPattern(namespace, appID, instanceID string) string {
	return InstancePrefix(namespace, appID, instanceID) + "%"
}

// ParseInstanceID returns the instance-id segment of a "||"-joined workflow key.
func ParseInstanceID(key string) (string, bool) {
	parts := strings.Split(key, KeyDelimiter)
	if len(parts) < 3 || parts[2] == "" {
		return "", false
	}
	return parts[2], true
}

// AllInstanceMetaPattern is a KeysLike LIKE pattern matching every instance's
// metadata key across ALL app-ids in the namespace ("%" matches both the
// leading app-id segment and the app-id inside the actor type).
func AllInstanceMetaPattern(namespace string) string {
	return "%" + KeyDelimiter +
		"dapr.internal." + namespace + "." + "%" + ".workflow" + KeyDelimiter +
		"%" + KeyDelimiter + SuffixMetadata
}

// ParseAppID returns the app-id segment (segment[0]) of a "||"-joined workflow
// key. Returns ok=false for a malformed key (fewer than three segments or an
// empty app-id segment).
func ParseAppID(key string) (string, bool) {
	parts := strings.Split(key, KeyDelimiter)
	if len(parts) < 3 || parts[0] == "" {
		return "", false
	}
	return parts[0], true
}

// HistoryKey returns the key suffix of an instance's i-th history entry,
// matching Dapr's naming: "history-" + i zero-padded to at least 6 digits.
// Prepend InstancePrefix to get the full key.
func HistoryKey(i uint64) string {
	s := strconv.FormatUint(i, 10)
	if len(s) < 6 {
		s = strings.Repeat("0", 6-len(s)) + s
	}
	return HistoryPrefix + s
}
