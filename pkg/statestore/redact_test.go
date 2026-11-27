//go:build unit

package statestore

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRedactSecrets(t *testing.T) {
	const pw = "S3cretPW"
	cases := []struct {
		name string
		msg  string
		comp Component
		want string
	}{
		{
			// Seen from components-contrib v1.19.0: it url.Parses the
			// connection string itself, so a malformed URL is echoed whole.
			name: "postgres malformed URL",
			msg:  `invalid URL connection string: parse "postgres://dashuser:` + pw + `@localhost:notaport/db": invalid port ":notaport" after host`,
			want: `invalid URL connection string: parse "postgres://dashuser:***@localhost:notaport/db": invalid port ":notaport" after host`,
		},
		{
			name: "redis URL pasted into redisHost",
			msg:  `redis store: error connecting to redis at [redis://u:` + pw + `@bad host:6379]:6379: dial tcp: lookup redis://u:` + pw + `@bad host:6379: no such host`,
			want: `redis store: error connecting to redis at [redis://u:***@bad host:6379]:6379: dial tcp: lookup redis://u:***@bad host:6379: no such host`,
		},
		{
			name: "URL userinfo without a user name",
			msg:  `dial "redis://:` + pw + `@h:6379" failed`,
			want: `dial "redis://:***@h:6379" failed`,
		},
		{
			name: "URL with a user name only keeps it",
			msg:  `parse "postgres://dashuser@h:x/db": invalid port`,
			want: `parse "postgres://dashuser@h:x/db": invalid port`,
		},
		{
			name: "key=value password",
			msg:  `cannot parse "host=h port=x user=u password=` + pw + ` dbname=d"`,
			want: `cannot parse "host=h port=x user=u password=*** dbname=d"`,
		},
		{
			name: "secret-named metadata value echoed verbatim",
			msg:  `auth failed for token ` + pw,
			comp: Component{Metadata: map[string]string{"redisPassword": pw}},
			want: `auth failed for token ***`,
		},
		{
			name: "value resolved from a secretKeyRef, whatever the field name",
			msg:  `bad value "` + pw + `"`,
			comp: Component{
				Metadata:   map[string]string{"connectionString": pw},
				SecretRefs: map[string]SecretRef{"connectionString": {Name: "pg", Key: "cs"}},
			},
			want: `bad value "***"`,
		},
		{
			name: "non-secret metadata is left alone",
			msg:  `error connecting to redis at localhost:1`,
			comp: Component{Metadata: map[string]string{"redisHost": "localhost:1"}},
			want: `error connecting to redis at localhost:1`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := redactSecrets(tc.msg, tc.comp)
			require.Equal(t, tc.want, got)
			require.NotContains(t, got, pw)
		})
	}
}

// TestNewRedactsInitError opens a real postgres store with a malformed URL
// (no network needed: the URL fails to parse) and checks that the password
// never reaches the error text while the cause stays matchable.
func TestNewRedactsInitError(t *testing.T) {
	const pw = "S3cretPW"
	_, err := New(context.Background(), Component{
		Name: "pg", Type: "state.postgresql",
		Metadata: map[string]string{"connectionString": "postgres://dashuser:" + pw + "@localhost:notaport/db"},
	})
	require.Error(t, err)
	require.NotContains(t, err.Error(), pw)
	require.Contains(t, err.Error(), `invalid port ":notaport"`)
	require.Contains(t, err.Error(), "init state.postgresql")

	open := &OpenError{Kind: errors.New("could not connect to state store"), Name: "pg", Cause: err}
	require.NotContains(t, open.Error(), pw)
}
