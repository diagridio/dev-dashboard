using Bridge.Actors;
using Bridge.Seed;
using Dapr.Client;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:6002");

builder.Services.AddDaprClient();
builder.Services.AddActors(options =>
{
    options.Actors.RegisterActor<SubsystemActor>();
    options.Actors.RegisterActor<DeckActor>();
});
builder.Services.AddSingleton<ISeedPort>(sp => new DaprSeedPort(sp.GetRequiredService<DaprClient>()));
builder.Services.AddSingleton(sp => new DemoController(
    sp.GetRequiredService<ISeedPort>(),
    sp.GetRequiredService<ILoggerFactory>().CreateLogger("bridge.seed")));
builder.Services.AddHostedService<SeedHostedService>();

var app = builder.Build();

app.MapActorsHandlers();

app.MapGet("/demo/status", (DemoController demo) =>
{
    var (seeded, error) = demo.Status();
    return error is null
        ? Results.Json(new { seeded })
        : Results.Json(new { seeded, error });
});

// Async: the reseed runs in the background; a second reset while one is in flight is a no-op.
app.MapPost("/demo/reset", (DemoController demo) =>
{
    demo.StartReset();
    return Results.Accepted();
});

app.Run();

/// <summary>Seeds once at startup without blocking the app from serving (the sidecar needs it up).</summary>
public sealed class SeedHostedService(DemoController demo, ILogger<SeedHostedService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await demo.SeedWithRetryAsync(TimeSpan.FromMinutes(5), stoppingToken);
            log.LogInformation("Bridge demo seeded");
        }
        catch (OperationCanceledException)
        {
            log.LogError("Bridge seed did not complete before its deadline");
        }
    }
}
