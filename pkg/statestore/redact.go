package statestore

import (
	"regexp"
	"sort"
	"strings"
)

// redacted replaces every secret found in an error message.
const redacted = "***"

// minSecretLen is the shortest metadata value replaced verbatim. Shorter
// values would match ordinary words and garble the message; passwords in
// URLs and key=value strings are still caught by the patterns below.
const minSecretLen = 4

var (
	// urlUserinfoPassword matches the password part of scheme://user:pass@.
	// The user name is kept: it helps diagnose the failure and is not secret.
	urlUserinfoPassword = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.\-]*://[^:/@\s"'\[\]]*):[^@\s"'/]*@`)
	// kvPassword matches password=… / pwd=… in key=value connection strings.
	kvPassword = regexp.MustCompile(`(?i)\b(password|pwd)\s*=\s*('[^']*'|[^\s;"']+)`)
)

// secretFieldHints are substrings of metadata field names whose values are
// secrets (redisPassword, password, clientSecret, apiKey, accessKey, ...).
var secretFieldHints = []string{"password", "secret", "token", "apikey", "accesskey", "credential"}

// redactSecrets removes credentials from msg, a driver error raised while
// opening c. Drivers echo their input on parse errors (components-contrib's
// postgres store url.Parses the connection string and quotes it whole, for
// example), and that text reaches API responses and the UI. It replaces:
//   - the value of every secret-named metadata field and every field that
//     came from a secretKeyRef/envRef (c.Metadata holds resolved values);
//   - the password in any scheme://user:password@ URL;
//   - password=/pwd= values in key=value connection strings.
func redactSecrets(msg string, c Component) string {
	var values []string
	for field, v := range c.Metadata {
		if len(v) < minSecretLen {
			continue
		}
		if _, fromRef := c.SecretRefs[field]; fromRef || secretField(field) {
			values = append(values, v)
		}
	}
	// Longest first, so a secret that contains another is replaced whole.
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, v := range values {
		msg = strings.ReplaceAll(msg, v, redacted)
	}
	msg = urlUserinfoPassword.ReplaceAllString(msg, "${1}:"+redacted+"@")
	msg = kvPassword.ReplaceAllString(msg, "${1}="+redacted)
	return msg
}

func secretField(name string) bool {
	n := strings.ToLower(name)
	for _, h := range secretFieldHints {
		if strings.Contains(n, h) {
			return true
		}
	}
	return false
}

// initError is a store Init failure whose message has its secrets removed
// (see redactSecrets). Unwrap keeps the driver error for errors.Is/As.
type initError struct {
	msg string
	err error
}

func (e *initError) Error() string { return e.msg }
func (e *initError) Unwrap() error { return e.err }
