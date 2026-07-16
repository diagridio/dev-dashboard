using System.Collections.Immutable;
using Aspire.Hosting.ApplicationModel;
using CommunityToolkit.Aspire.Hosting.Dapr;
using Microsoft.Extensions.DependencyInjection;

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

// NOTE: Redis (the actor state store) is intentionally NOT an Aspire resource.
// The daprd sidecar loads the state-store component during startup and FATALLY
// EXITS if Redis isn't yet accepting connections. Aspire starts the sidecar as
// its own resource outside the WaitFor graph (WaitFor on the sidecar is not
// honored), so it always races an Aspire-managed Redis container and loses
// under load. Instead the Go test starts Redis and waits for it to accept
// connections BEFORE launching this AppHost, and the component YAML it writes
// points daprd at 127.0.0.1:<redisPort>. That makes the sidecar's component
// init race-free by construction.

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

var app = builder.Build();

// Aspire runs headless here (DisableDashboard) and does not otherwise surface
// child-resource logs. Forward every resource's logs to the AppHost's stdout so
// CI captures daprd/OrderService output — the only window into why the sidecar
// fails to initialize on the runner.
_ = Task.Run(async () =>
{
    var notifications = app.Services.GetRequiredService<ResourceNotificationService>();
    var loggers = app.Services.GetRequiredService<ResourceLoggerService>();
    var watched = new HashSet<string>();
    await foreach (var evt in notifications.WatchAsync())
    {
        if (!watched.Add(evt.ResourceId))
        {
            continue;
        }
        var resourceId = evt.ResourceId;
        _ = Task.Run(async () =>
        {
            await foreach (var batch in loggers.WatchAsync(resourceId))
            {
                foreach (var line in batch)
                {
                    Console.WriteLine($"[resource:{resourceId}] {line.Content}");
                }
            }
        });
    }
});

app.Run();
