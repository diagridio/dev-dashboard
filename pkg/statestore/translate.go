package statestore

import (
	"net/url"
	"strconv"
	"strings"
)

// HostLookup resolves a compose-network hostname + port to a host-reachable
// "host:port". ok=false leaves the original address untouched.
type HostLookup func(host string, port int) (string, bool)

// PathLookup resolves a container-internal file path to a host path.
type PathLookup func(containerPath string) (string, bool)

// Translate rewrites c's connection metadata for access from the host:
// state.redis redisHost, state.postgresql/postgres connection strings (URL or
// key=value DSN), and state.sqlite file paths. Only exact lookup hits are
// rewritten — foreign hostnames pass through so a connection failure stays
// honest. Copy-on-write: c is never mutated; the returned Component carries a
// fresh Metadata map only when something changed.
func Translate(c Component, hosts HostLookup, paths PathLookup) Component {
	if c.Metadata == nil {
		return c
	}
	set := func(k, v string) {
		md := make(map[string]string, len(c.Metadata))
		for kk, vv := range c.Metadata {
			md[kk] = vv
		}
		md[k] = v
		c.Metadata = md
	}
	switch c.Type {
	case "state.redis":
		if hosts == nil {
			return c
		}
		host, portStr, ok := strings.Cut(c.Metadata["redisHost"], ":")
		if !ok {
			return c
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return c
		}
		if translated, ok := hosts(host, port); ok {
			set("redisHost", translated)
		}
	case "state.postgresql", "state.postgres":
		if hosts == nil {
			return c
		}
		if cs, ok := translatePGConnString(c.Metadata["connectionString"], hosts); ok {
			set("connectionString", cs)
		}
	case "state.sqlite":
		if paths == nil {
			return c
		}
		file, query, hasQuery := strings.Cut(c.Metadata["connectionString"], "?")
		if hostPath, ok := paths(file); ok {
			if hasQuery {
				hostPath += "?" + query
			}
			set("connectionString", hostPath)
		}
	case "state.mongodb":
		if hosts == nil {
			return c
		}
		// Only the bare host:port form is translatable. A mongodb:// URI or
		// mongodb+srv address passes through untouched (SRV has no host:port).
		host, portStr, ok := strings.Cut(c.Metadata["host"], ":")
		if !ok {
			return c
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return c
		}
		if translated, ok := hosts(host, port); ok {
			set("host", translated)
		}
	}
	return c
}

// translatePGConnString rewrites host/port in a PostgreSQL URL
// (postgres://...) or key=value DSN. ok=false means nothing was rewritten.
func translatePGConnString(cs string, hosts HostLookup) (string, bool) {
	if cs == "" {
		return "", false
	}
	if strings.HasPrefix(cs, "postgres://") || strings.HasPrefix(cs, "postgresql://") {
		u, err := url.Parse(cs)
		if err != nil {
			return "", false
		}
		port := 5432
		if p := u.Port(); p != "" {
			n, err := strconv.Atoi(p)
			if err != nil {
				return "", false
			}
			port = n
		}
		translated, ok := hosts(u.Hostname(), port)
		if !ok {
			return "", false
		}
		u.Host = translated
		return u.String(), true
	}
	// key=value DSN (libpq style, space separated)
	fields := strings.Fields(cs)
	hostIdx, portIdx := -1, -1
	host, port := "", 5432
	for i, f := range fields {
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			continue
		}
		switch k {
		case "host":
			hostIdx, host = i, v
		case "port":
			if n, err := strconv.Atoi(v); err == nil {
				portIdx, port = i, n
			}
		}
	}
	if hostIdx == -1 {
		return "", false
	}
	translated, ok := hosts(host, port)
	if !ok {
		return "", false
	}
	th, tp, ok := strings.Cut(translated, ":")
	if !ok {
		return "", false
	}
	fields[hostIdx] = "host=" + th
	if portIdx >= 0 {
		fields[portIdx] = "port=" + tp
	} else {
		fields = append(fields, "port="+tp)
	}
	return strings.Join(fields, " "), true
}
