//go:build unit

package statestore

import "testing"

func sagaHosts(host string, port int) (string, bool) {
	if host == "redis" && port == 6379 {
		return "localhost:16379", true
	}
	if host == "postgres-db" && port == 5432 {
		return "localhost:15432", true
	}
	return "", false
}

func TestTranslateRedis(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "redis:6379", "redisPassword": "x"}}
	got := Translate(c, sagaHosts, nil)
	if got.Metadata["redisHost"] != "localhost:16379" {
		t.Fatalf("redisHost: %q", got.Metadata["redisHost"])
	}
	if got.Metadata["redisPassword"] != "x" {
		t.Fatal("other metadata must survive")
	}
	if c.Metadata["redisHost"] != "redis:6379" {
		t.Fatal("input must not be mutated")
	}
}

func TestTranslateRedisUnknownHostUntouched(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "prod.example.com:6379"}}
	if got := Translate(c, sagaHosts, nil); got.Metadata["redisHost"] != "prod.example.com:6379" {
		t.Fatalf("foreign host must be untouched: %q", got.Metadata["redisHost"])
	}
}

func TestTranslatePostgresURL(t *testing.T) {
	c := Component{Type: "state.postgresql", Metadata: map[string]string{
		"connectionString": "postgres://postgres:pw@postgres-db:5432/dapr?sslmode=disable"}}
	got := Translate(c, sagaHosts, nil)
	want := "postgres://postgres:pw@localhost:15432/dapr?sslmode=disable"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslatePostgresDSN(t *testing.T) {
	c := Component{Type: "state.postgres", Metadata: map[string]string{
		"connectionString": "host=postgres-db user=postgres password=pw port=5432 dbname=dapr"}}
	got := Translate(c, sagaHosts, nil)
	want := "host=localhost user=postgres password=pw port=15432 dbname=dapr"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslatePostgresDSNDefaultPort(t *testing.T) {
	c := Component{Type: "state.postgresql", Metadata: map[string]string{
		"connectionString": "host=postgres-db user=postgres dbname=dapr"}}
	got := Translate(c, sagaHosts, nil)
	want := "host=localhost user=postgres dbname=dapr port=15432"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslateSQLitePath(t *testing.T) {
	paths := func(p string) (string, bool) {
		if p == "/data/state.db" {
			return "/host/data/state.db", true
		}
		return "", false
	}
	c := Component{Type: "state.sqlite", Metadata: map[string]string{"connectionString": "/data/state.db?mode=rw"}}
	got := Translate(c, nil, paths)
	if got.Metadata["connectionString"] != "/host/data/state.db?mode=rw" {
		t.Fatalf("got %q", got.Metadata["connectionString"])
	}
}

func TestTranslateNilLookupsNoop(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "redis:6379"}}
	if got := Translate(c, nil, nil); got.Metadata["redisHost"] != "redis:6379" {
		t.Fatal("nil lookups must be a no-op")
	}
}

func TestTranslateMongoHostRewrite(t *testing.T) {
	hosts := func(host string, port int) (string, bool) {
		if host == "mongo" && port == 27017 {
			return "127.0.0.1:55017", true
		}
		return "", false
	}
	c := Component{Type: "state.mongodb", Metadata: map[string]string{"host": "mongo:27017"}}
	got := Translate(c, hosts, nil)
	if got.Metadata["host"] != "127.0.0.1:55017" {
		t.Fatalf("host: expected %q, got %q", "127.0.0.1:55017", got.Metadata["host"])
	}
}

func TestTranslateMongoForeignHostUntouched(t *testing.T) {
	hosts := func(string, int) (string, bool) { return "", false }
	c := Component{Type: "state.mongodb", Metadata: map[string]string{"host": "prod.example.com:27017"}}
	got := Translate(c, hosts, nil)
	if got.Metadata["host"] != "prod.example.com:27017" {
		t.Fatalf("host: expected %q, got %q", "prod.example.com:27017", got.Metadata["host"])
	}
}

func TestTranslateMongoNonHostPortFormsUntouched(t *testing.T) {
	// A lookup that would rewrite anything it is consulted with: proves the
	// mongodb branch never even attempts translation for these forms.
	hosts := func(string, int) (string, bool) { return "localhost:99999", true }
	for _, host := range []string{
		"mongodb://user:pass@db:27017/orders",
		"mongodb+srv://cluster.example.com",
		"host1:27017,host2:27017",
	} {
		c := Component{Type: "state.mongodb", Metadata: map[string]string{"host": host}}
		if got := Translate(c, hosts, nil); got.Metadata["host"] != host {
			t.Fatalf("host %q must pass through unchanged, got %q", host, got.Metadata["host"])
		}
	}
}
