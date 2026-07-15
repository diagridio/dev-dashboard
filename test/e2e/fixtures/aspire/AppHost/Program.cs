using System.Collections.Immutable;
using CommunityToolkit.Aspire.Hosting.Dapr;

// Every host-facing port and path is chosen by the Go e2e test (which uses
// the harness's freePort helper, matching the compose/testcontainers
// fixtures — no hardcoded host ports) and handed in via environment
// variables. The AppHost only pins the resources to those values.
static int RequiredPort(string name)
{
    var raw = Environment.GetEnvironmentVariable(name)
        ?? throw new InvalidOperationException($"{name} not set");
    return int.TryParse(raw, out var port)
        ? port
        : throw new InvalidOperationException($"{name}: expected a port number, got '{raw}'");
}

static string Required(string name) =>
    Environment.GetEnvironmentVariable(name)
    ?? throw new InvalidOperationException($"{name} not set");

var redisPort = RequiredPort("REDIS_PORT");
var orderServiceDaprHttpPort = RequiredPort("ORDERSERVICE_DAPR_HTTP_PORT");
// Directory the Go test wrote e2easpirestatestore.yaml into (redisHost
// already points at the chosen redis port). Shared by the daprd sidecar
// (loads the component) and the dashboard (DEVDASHBOARD_RESOURCES_PATH).
var componentsDir = Required("COMPONENTS_DIR");

var builder = DistributedApplication.CreateBuilder(new DistributedApplicationOptions
{
    Args = args,
    // The e2e fixture has no trusted dev certificate and does not need TLS
    // between resources; forcing plain HTTP avoids cert-trust prompts/failures
    // and the redis container's default TLS listener.
    DeveloperCertificateDefaultHttpsTerminationEnabled = false,
    AllowUnsecuredTransport = true,
    // No need for the Aspire dashboard UI in this headless e2e fixture.
    DisableDashboard = true,
});

// Redis for the Dapr state store component. AddContainer + WithEndpoint(...,
// isProxied: false) publishes the chosen host port straight through to the
// container so the component YAML (written by the Go test) can name it;
// Aspire.Hosting.Redis's AddRedis() helper instead enables TLS and a random
// per-run password by default, which daprd would then need extra wiring to
// trust/authenticate against.
builder.AddContainer("statestore-redis", "redis", "7-alpine")
    .WithEndpoint(port: redisPort, targetPort: 6379, scheme: "tcp", name: "tcp", isProxied: false);

// The OrderService Dapr workflow app, with its sidecar HTTP port pinned to
// the test-chosen port so the dashboard's env contract (below) can name it.
var orders = builder.AddProject<Projects.OrderService>("orderservice")
    .WithDaprSidecar(new DaprSidecarOptions
    {
        AppId = "orderservice",
        DaprHttpPort = orderServiceDaprHttpPort,
        ResourcesPaths = ImmutableHashSet.Create(componentsDir),
        // Reuse the placement/scheduler containers `dapr init` already runs
        // on this machine instead of having Aspire try to provision its own.
        PlacementHostAddress = "localhost:50005",
        SchedulerHostAddress = "localhost:50006",
    });

var dashBin = Required("DASH_BIN");
var dashPort = Environment.GetEnvironmentVariable("DASH_PORT") ?? "9099";

// Pre-formatted into plain string locals: passing an interpolated string
// literal directly to WithEnvironment binds to its ExpressionInterpolatedStringHandler
// overload (for capturing resource references), which rejects a plain int
// hole like {orderServiceDaprHttpPort}.
string orderServiceDaprHttpUrl = "http://localhost:" + orderServiceDaprHttpPort;
string stateStoreFile = Path.Combine(componentsDir, "e2easpirestatestore.yaml");

// The dashboard is launched by the AppHost as a plain executable resource in
// aspire mode. `.WithReference(orders)` alone does not inject the
// DEVDASHBOARD_APP_* env contract the dashboard's aspire scanner reads
// (pkg/discovery/scan_aspire.go) — it must be set explicitly.
builder.AddExecutable("dashboard", dashBin, componentsDir,
        "--mode", "aspire", "--port", dashPort, "--bind", "0.0.0.0", "--no-open")
    .WithEnvironment("DEVDASHBOARD_APP_COUNT", "1")
    .WithEnvironment("DEVDASHBOARD_APP_0_ID", "orderservice")
    .WithEnvironment("DEVDASHBOARD_APP_0_DAPR_HTTP", orderServiceDaprHttpUrl)
    .WithEnvironment("DEVDASHBOARD_RESOURCES_PATH", componentsDir)
    // Workflows capability in aspire container posture is gated on an
    // explicit state-store component path (cmd/root.go: caps.Workflows =
    // settings.StateStore != ""); auto-detect across ResourcesPaths is not
    // enough here.
    .WithEnvironment("DEVDASHBOARD_STATESTORE_FILE", stateStoreFile);

builder.Build().Run();
