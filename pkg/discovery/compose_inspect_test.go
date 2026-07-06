//go:build unit

package discovery

import (
	"os"
	"testing"
)

func TestParseComposeContainers(t *testing.T) {
	data, err := os.ReadFile("testdata/compose_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseComposeContainers(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 containers, got %d", len(got))
	}
	sc := got[0]
	if sc.Name != "saga-primes-go-dapr-1" || sc.Project != "saga" || sc.Service != "primes-go-dapr" {
		t.Fatalf("sidecar identity: %+v", sc)
	}
	if !sc.Running || sc.StartedAt.IsZero() {
		t.Fatalf("sidecar state: %+v", sc)
	}
	if sc.Argv[0] != "./daprd" {
		t.Fatalf("argv should combine entrypoint+cmd: %v", sc.Argv)
	}
	if sc.Ports[3500] != 3500 {
		t.Fatalf("published port: %v", sc.Ports)
	}
	if _, ok := sc.Ports[50001]; ok {
		t.Fatalf("unpublished port must be absent: %v", sc.Ports)
	}
	if sc.Mounts["/components"] != "/Users/dev/saga/components" {
		t.Fatalf("mounts: %v", sc.Mounts)
	}
	app := got[1]
	if app.Argv[0] != "/app/server" {
		t.Fatalf("entrypoint-only argv: %v", app.Argv)
	}
	pg := got[2]
	if len(pg.Mounts) != 0 {
		t.Fatalf("named volume must not appear in bind mounts: %v", pg.Mounts)
	}
	if pg.Ports[5432] != 5432 {
		t.Fatalf("postgres port: %v", pg.Ports)
	}
}

func TestParseComposeContainersSkipsUnlabelled(t *testing.T) {
	data := []byte(`[{"Id":"x","Name":"/plain","Config":{"Labels":{}}}]`)
	got, err := parseComposeContainers(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("unlabelled container must be skipped, got %d", len(got))
	}
}

func TestTranslateMountPath(t *testing.T) {
	mounts := map[string]string{"/components": "/host/components", "/dapr_config": "/host/cfg"}
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"/components", "/host/components", true},
		{"/dapr_config/config.yml", "/host/cfg/config.yml", true},
		{"/components/sub/state.yaml", "/host/components/sub/state.yaml", true},
		{"/componentsX", "", false},
		{"/elsewhere/db.sqlite", "", false},
	}
	for _, tt := range tests {
		got, ok := TranslateMountPath(mounts, tt.in)
		if ok != tt.ok || got != tt.want {
			t.Fatalf("TranslateMountPath(%q) = %q,%v want %q,%v", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}
