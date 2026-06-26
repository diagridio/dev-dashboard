package statestore

import "strings"

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
