package statestore

import (
	"net/url"
	"strings"
)

// ConnInfo returns a short, human-readable connection summary for a component,
// suitable for display in the UI. It NEVER includes credentials (passwords or
// user info). Returns "" when no usable, non-secret metadata is present.
func ConnInfo(c Component) string {
	switch c.Type {
	case "state.redis":
		return c.Metadata["redisHost"]
	case "state.sqlite":
		// connectionString for sqlite is a local file path (or ":memory:"),
		// which contains no secret.
		return strings.TrimSpace(c.Metadata["connectionString"])
	case "state.postgresql", "state.postgres":
		return pgConnInfo(c.Metadata["connectionString"])
	default:
		return ""
	}
}

// pgConnInfo extracts a secrets-free "host[:port][/dbname]" summary from a
// Postgres connection string in either URL form
// (postgres://user:pass@host:5432/db) or keyword/DSN form
// (host=localhost port=5432 dbname=db user=... password=...).
// User and password are always discarded.
func pgConnInfo(cs string) string {
	cs = strings.TrimSpace(cs)
	if cs == "" {
		return ""
	}
	if strings.HasPrefix(cs, "postgres://") || strings.HasPrefix(cs, "postgresql://") {
		u, err := url.Parse(cs)
		if err != nil {
			return ""
		}
		// u.Host is host[:port] and excludes userinfo; u.Path is "/dbname".
		db := strings.TrimPrefix(u.Path, "/")
		if u.Host != "" && db != "" {
			return u.Host + "/" + db
		}
		return u.Host
	}
	// Keyword/DSN form: collect only host, port, dbname/database.
	var host, port, db string
	for _, field := range strings.Fields(cs) {
		kv := strings.SplitN(field, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch strings.ToLower(kv[0]) {
		case "host":
			host = kv[1]
		case "port":
			port = kv[1]
		case "dbname", "database":
			db = kv[1]
		}
	}
	hostPort := host
	if host != "" && port != "" {
		hostPort = host + ":" + port
	}
	switch {
	case hostPort != "" && db != "":
		return hostPort + "/" + db
	case hostPort != "":
		return hostPort
	default:
		return db
	}
}
