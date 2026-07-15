using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using CommunityToolkit.Aspire.Hosting.Dapr;

// Absolute path to this source file's directory (the AppHost project dir),
// resolved at compile time so it is correct regardless of the process's
// working directory at run time (dotnet run's CWD is not guaranteed to be
// the project directory).
static string ThisDir([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;

var appHostDir = ThisDir();
var componentsDir = Path.Combine(appHostDir, "components");

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
// isProxied: false) pins the exact host port so the component YAML (below)
// can name it statically; Aspire.Hosting.Redis's AddRedis() helper instead
// enables TLS and a random per-run password by default, which daprd would
// then need extra wiring to trust/authenticate against.
const int redisPort = 16379;
builder.AddContainer("statestore-redis", "redis", "7-alpine")
    .WithEndpoint(port: redisPort, targetPort: 6379, scheme: "tcp", name: "tcp", isProxied: false);

// The Dapr component pointed at by DaprSidecarOptions.ResourcesPaths below.
// Written statically because the redis port is pinned above, not resolved at
// run time.
Directory.CreateDirectory(componentsDir);
File.WriteAllText(Path.Combine(componentsDir, "e2easpirestatestore.yaml"), $"""
    apiVersion: dapr.io/v1alpha1
    kind: Component
    metadata:
      name: e2easpirestatestore
    spec:
      type: state.redis
      version: v1
      metadata:
      - name: redisHost
        value: localhost:{redisPort}
      - name: actorStateStore
        value: "true"
    """);

// The OrderService Dapr workflow app, with its sidecar pinned to a known
// HTTP port so the dashboard's env contract (below) can name it directly.
const int orderServiceDaprHttpPort = 3513;
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

var dashBin = Environment.GetEnvironmentVariable("DASH_BIN")
    ?? throw new InvalidOperationException("DASH_BIN not set");
var dashPort = Environment.GetEnvironmentVariable("DASH_PORT") ?? "9099";

// Pre-formatted into plain string locals: passing an interpolated string
// literal directly to WithEnvironment binds to its ExpressionInterpolatedStringHandler
// overload (for capturing resource references), which rejects a plain int
// hole like {orderServiceDaprHttpPort}.
string orderServiceDaprHttpUrl = "http://localhost:" + orderServiceDaprHttpPort;

// The dashboard is launched by the AppHost as a plain executable resource in
// aspire mode. `.WithReference(orders)` alone does not inject the
// DEVDASHBOARD_APP_* env contract the dashboard's aspire scanner reads
// (pkg/discovery/scan_aspire.go) — it must be set explicitly.
builder.AddExecutable("dashboard", dashBin, appHostDir,
        "--mode", "aspire", "--port", dashPort, "--bind", "0.0.0.0", "--no-open")
    .WithEnvironment("DEVDASHBOARD_APP_COUNT", "1")
    .WithEnvironment("DEVDASHBOARD_APP_0_ID", "orderservice")
    .WithEnvironment("DEVDASHBOARD_APP_0_DAPR_HTTP", orderServiceDaprHttpUrl)
    .WithEnvironment("DEVDASHBOARD_RESOURCES_PATH", componentsDir)
    // Workflows capability in aspire container posture is gated on an
    // explicit state-store component path (cmd/root.go: caps.Workflows =
    // settings.StateStore != ""); auto-detect across ResourcesPaths is not
    // enough here.
    .WithEnvironment("DEVDASHBOARD_STATESTORE_FILE", Path.Combine(componentsDir, "e2easpirestatestore.yaml"));

builder.Build().Run();
