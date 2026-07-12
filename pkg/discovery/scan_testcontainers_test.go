//go:build unit

package discovery

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// testcontainersInspectJSON is trimmed from a live `docker inspect` of a
// dapr-spring-boot-starter-test session (daprd 1.18 + scheduler; the scheduler
// exercises the "session container without daprd argv" exclusion path).
const testcontainersInspectJSON = `[
  {
    "Id": "28af628017d1",
    "Name": "/crazy_lamport",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:28:40.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.lang": "java",
        "org.testcontainers.sessionId": "efeba7ba-5fdd-4713-ae0c-38f4a462cf46"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "--app-id", "workflow-patterns-app", "--dapr-listen-addresses=0.0.0.0", "--placement-host-address", "placement:50005", "--scheduler-host-address", "scheduler:51005", "--app-channel-address", "host.testcontainers.internal", "--app-port", "8080", "--app-protocol", "http", "--log-level", "INFO", "--resources-path", "/dapr-resources"]
    },
    "NetworkSettings": {
      "Ports": {
        "3500/tcp": [ { "HostPort": "58444" } ],
        "50001/tcp": [ { "HostPort": "58445" } ]
      }
    },
    "Mounts": []
  },
  {
    "Id": "636f969c5645",
    "Name": "/jolly_franklin",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:28:35.000000000Z" },
    "Config": {
      "Image": "daprio/scheduler:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.sessionId": "efeba7ba-5fdd-4713-ae0c-38f4a462cf46"
      },
      "Entrypoint": ["./scheduler"],
      "Cmd": ["--port", "51005", "--etcd-data-dir", "/var/lock/dapr/scheduler"]
    },
    "NetworkSettings": { "Ports": { "51005/tcp": [ { "HostPort": "58413" } ] } },
    "Mounts": []
  }
]`

func fakeTestcontainersRunner(t *testing.T) *fakeCRT {
	t.Helper()
	return &fakeCRT{responses: map[string][]byte{
		"ps -aq":               []byte("28af628017d1\n636f969c5645\n"),
		"inspect 28af628017d1": []byte(testcontainersInspectJSON),
	}}
}

func TestTestcontainersScanner_DiscoversDaprdAndExcludesHelpers(t *testing.T) {
	src := NewTestcontainersSource(fakeTestcontainersRunner(t))
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Len(t, results, 1)
	r := results[0]
	require.Equal(t, "workflow-patterns-app", r.AppID)
	require.Equal(t, SourceTestcontainers, r.Source)
	require.Equal(t, 58444, r.HTTPPort)
	require.Equal(t, 58445, r.GRPCPort)
	require.Equal(t, 8080, r.AppPort)
	require.Equal(t, "28af628017d1", r.DaprdContainerID)
	require.Equal(t, "crazy_lamport", r.DaprdContainerName)
	require.Equal(t, StatusRunning, r.DaprdStatus)
	require.Equal(t, "efeba7ba-5fdd-4713-ae0c-38f4a462cf46", r.TestcontainersSession)
	require.True(t, r.SidecarReachable)
	require.Equal(t, "crazy_lamport", r.Key())
}

func TestTestcontainersScanner_NilRunnerIsEmptyAndErrorFree(t *testing.T) {
	src := NewTestcontainersSource(nil)
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Empty(t, results)
}
