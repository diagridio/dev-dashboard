using System.Net.Http.Json;
using System.Text.Json;
using Bridge.Actors;
using Dapr.Actors;
using Dapr.Actors.Client;
using Dapr.Client;

namespace Bridge.Seed;

/// <summary>Production ISeedPort backed by the Dapr sidecar.</summary>
public sealed class DaprSeedPort(DaprClient client) : ISeedPort
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private sealed record SickbayStatus(bool Seeded, string? Error);
    private sealed record SweepItem(string Id, string Status);
    private sealed record StatusReport(List<SweepItem>? Sweeps);

    public async Task<string> GetSecretAsync(string store, string key, CancellationToken ct)
    {
        var secret = await client.GetSecretAsync(store, key, cancellationToken: ct);
        return secret.TryGetValue(key, out var value) ? value : throw new InvalidOperationException($"secret '{key}' not found");
    }

    public async Task ActivateActorAsync(string actorType, string actorId, CancellationToken ct)
    {
        if (actorType == Scenario.SubsystemActorType)
        {
            await ActorProxy.Create<ISubsystemActor>(new ActorId(actorId), actorType).InitializeAsync();
        }
        else
        {
            await ActorProxy.Create<IDeckActor>(new ActorId(actorId), actorType).InitializeAsync();
        }
    }

    public async Task RegisterReminderAsync(string actorType, string actorId, string name, TimeSpan due, TimeSpan period, CancellationToken ct)
    {
        // The actor registers its own reminder; (re)registering by name never duplicates it.
        await ActorProxy.Create<ISubsystemActor>(new ActorId(actorId), actorType).RegisterHeartbeatAsync();
    }

    public Task PublishAsync(string topic, object payload, CancellationToken ct) =>
        client.PublishEventAsync("pubsub", topic, payload, ct);

    public async Task<bool> IsSickbaySeededAsync(CancellationToken ct)
    {
        using var http = client.CreateInvokableHttpClient("sickbay");
        var status = await http.GetFromJsonAsync<SickbayStatus>("demo/status", Json, ct);
        return status?.Seeded ?? false;
    }

    public async Task<string> GetEngineeringStatusReportAsync(CancellationToken ct)
    {
        using var http = client.CreateInvokableHttpClient("engineering");
        using var response = await http.PostAsync("status-report", null, ct);
        response.EnsureSuccessStatusCode();
        var report = await response.Content.ReadFromJsonAsync<StatusReport>(Json, ct);
        var sweeps = report?.Sweeps ?? [];
        return string.Join(", ", sweeps.Select(s => $"{s.Id}={s.Status}"));
    }

    public async Task ResetAsync(CancellationToken ct)
    {
        foreach (var id in Scenario.Subsystems)
        {
            await ActorProxy.Create<ISubsystemActor>(new ActorId(id), Scenario.SubsystemActorType).ResetAsync();
        }
        foreach (var id in Scenario.Decks)
        {
            await ActorProxy.Create<IDeckActor>(new ActorId(id), Scenario.DeckActorType).ResetAsync();
        }
    }
}
