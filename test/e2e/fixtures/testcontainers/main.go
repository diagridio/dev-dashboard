// Command tcfixture starts a TestContainers session (redis + placement +
// scheduler + daprd sidecar + wfapp) with the component YAML copied into the
// daprd container, schedules a workflow, prints markers, and blocks until
// signalled. Used only by the e2e test; the dashboard scans the running
// containers while this program is alive.
//
// The topology mirrors test/e2e/fixtures/compose/docker-compose.yaml (a
// proven-working Dapr setup): workflows require both a placement service and
// a scheduler service, or the workflow never runs. wfapp is a pure workflow
// client/worker that never binds a port, so daprd must NOT be given
// -app-channel-address/-app-port (that makes daprd's placement client hang
// indefinitely waiting on an app channel nothing will ever answer).
//
// This fixture runs daprd/placement/scheduler at 1.18.1, and unlike the
// compose fixture it REQUIRES daprd 1.17+: the dashboard's workflow composite
// service always routes testcontainers apps through the sidecar's gRPC
// workflow-management API (ListInstanceIDs/GetInstanceHistory), which daprd
// only answers on 1.17+ (pre-1.17 returns codes.Unimplemented — see
// pkg/workflow/sidecar.go's ErrSidecarUnsupported). Component/resource
// discovery (tar-extraction) is version-independent, but the workflow
// assertion in the e2e test would fail on pre-1.17 for this reason alone.
package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/network"
	"github.com/testcontainers/testcontainers-go/wait"
)

func main() {
	ctx := context.Background()

	net, err := network.New(ctx)
	must(err)

	// Redis on the shared network with alias "redis"; exposed so the
	// dashboard (running on the host) can also reach it directly when
	// reading workflow state back through the elected active store.
	redisC, err := tcredis.Run(ctx, "redis:7",
		network.WithNetwork([]string{"redis"}, net),
	)
	must(err)

	// Placement service — required for Dapr actor/workflow placement.
	placement, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:          "daprio/placement:1.18.1",
			Networks:       []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"placement"}},
			Cmd:            []string{"./placement", "-port", "50005"},
			ExposedPorts:   []string{"50005/tcp"},
			WaitingFor:     wait.ForListeningPort("50005/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	must(err)
	_ = placement

	// Scheduler service — Dapr workflow scheduling hard-depends on it
	// (SchedulerReminders is on by default). --etcd-data-dir must be a
	// writable path; the image's default "./data" fails under its non-root
	// user with "permission denied".
	scheduler, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:          "daprio/scheduler:1.18.1",
			Networks:       []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"scheduler"}},
			Cmd:            []string{"./scheduler", "--port", "50006", "--etcd-data-dir", "/tmp/scheduler-data"},
			ExposedPorts:   []string{"50006/tcp"},
			WaitingFor:     wait.ForListeningPort("50006/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	must(err)
	_ = scheduler

	// daprd sidecar with the component YAML copied in at /components (tar
	// extraction, not a bind mount — that is the discovery path under test).
	comp, err := os.ReadFile("components/statestore.yaml")
	must(err)
	daprd, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:          "daprio/daprd:1.18.1",
			Networks:       []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"daprd"}},
			Cmd: []string{
				"./daprd",
				"-app-id", "wfapp",
				"-dapr-http-port", "3500",
				"-dapr-grpc-port", "50001",
				"-resources-path", "/components",
				"-placement-host-address", "placement:50005",
				"-scheduler-host-address", "scheduler:50006",
			},
			Files: []testcontainers.ContainerFile{
				{
					Reader:            bytes.NewReader(comp),
					ContainerFilePath: "/components/statestore.yaml",
					FileMode:          0o644,
				},
			},
			ExposedPorts: []string{"3500/tcp", "50001/tcp"},
			WaitingFor:   wait.ForListeningPort("3500/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	must(err)
	_ = daprd

	// wfapp container (built by the e2e test into image "tcfixture-wfapp").
	// It never binds a port, so it joins the shared network by alias only
	// and reaches daprd outbound via the "daprd" alias.
	wfapp, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:          "tcfixture-wfapp",
			Networks:       []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"wfapp"}},
			Env: map[string]string{
				"DAPR_GRPC_ENDPOINT": "daprd:50001",
				"DAPR_HTTP_ENDPOINT": "http://daprd:3500",
			},
		},
		Started: true,
	})
	must(err)

	fmt.Println("TCFIXTURE_READY")

	// Block until signalled; the e2e test scans the containers meanwhile.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Println("TCFIXTURE_STOPPING")

	// Terminate everything explicitly rather than relying solely on Ryuk's
	// connection-loss reaping: that reaper only notices this process's
	// session ends once its keep-alive connection drops and then waits out
	// its own timeout, which leaves a window where containers/network are
	// still visible right after this process exits — exactly what the e2e
	// test's cleanup check (docker ps immediately after the test) would
	// otherwise catch as a stray. Best-effort: log and continue on error so
	// one stuck container doesn't block cleanup of the rest.
	stopCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, c := range []testcontainers.Container{wfapp, daprd, scheduler, placement, redisC} {
		if err := c.Terminate(stopCtx); err != nil {
			fmt.Fprintln(os.Stderr, "fixture cleanup: terminate container:", err)
		}
	}
	if err := net.Remove(stopCtx); err != nil {
		fmt.Fprintln(os.Stderr, "fixture cleanup: remove network:", err)
	}
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "fixture error:", err)
		os.Exit(1)
	}
}
