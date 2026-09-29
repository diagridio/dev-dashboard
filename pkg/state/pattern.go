package state

import (
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// escapeLike escapes the SQL-LIKE metacharacters so user-supplied text matches
// literally. All four supported backends translate the LIKE pattern to their
// native matcher (redis glob, mongo regex, native LIKE for the SQL pair) and
// all four honor backslash escapes for %, _ and \.
//
// Without this, searching for "order_42" silently also matches "order-42", and
// an app named "my_app" matches "myXapp".
func escapeLike(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		if r == '\\' || r == '%' || r == '_' {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// listPattern builds the KeysLike pattern for a query, pushing both the app
// filter and the key search into the backend. Because every interpolated
// fragment is escaped, the result is always a valid pattern — there is no user
// input that can make the backend's pattern parser fail.
//
// KeysLike rejects an empty pattern, so the unfiltered case is "%".
func listPattern(appID, search string) string {
	prefix := "%"
	if appID != "" {
		prefix = escapeLike(appID) + statestore.KeyDelimiter + "%"
	}
	if search == "" {
		return prefix
	}
	return prefix + escapeLike(search) + "%"
}
