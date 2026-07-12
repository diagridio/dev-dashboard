//go:build unit

package discovery

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
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

func TestParseInspectContainers_KeepsUnlabeledAndExposesLabels(t *testing.T) {
	data := []byte(`[
  {
    "Id": "tc1",
    "Name": "/crazy_lamport",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.sessionId": "efeba7ba"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "--app-id", "workflow-patterns-app"]
    },
    "NetworkSettings": { "Ports": { "3500/tcp": [ { "HostPort": "58444" } ] } },
    "Mounts": []
  },
  {
    "Id": "c1",
    "Name": "/checkout-dapr-1",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.15.0",
      "Labels": { "com.docker.compose.project": "checkout", "com.docker.compose.service": "checkout" },
      "Entrypoint": null,
      "Cmd": ["./daprd"]
    },
    "NetworkSettings": { "Ports": {} },
    "Mounts": []
  }
]`)
	all, err := parseInspectContainers(data)
	require.NoError(t, err)
	require.Len(t, all, 2)
	require.Equal(t, "true", all[0].Labels["org.testcontainers"])
	require.Equal(t, "efeba7ba", all[0].Labels["org.testcontainers.sessionId"])
	require.Empty(t, all[0].Project)
	require.Equal(t, "checkout", all[1].Project)

	// parseComposeContainers keeps filtering to compose-labeled containers only.
	compose, err := parseComposeContainers(data)
	require.NoError(t, err)
	require.Len(t, compose, 1)
	require.Equal(t, "checkout", compose[0].Project)
}
