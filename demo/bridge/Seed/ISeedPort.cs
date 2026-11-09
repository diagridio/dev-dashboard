namespace Bridge.Seed;

/// <summary>Everything the seeder needs from the outside world (Dapr in production, a fake in tests).</summary>
public interface ISeedPort
{
    Task<string> GetSecretAsync(string store, string key, CancellationToken ct);

    /// <summary>Activates the actor so it shows up in the actors list.</summary>
    Task ActivateActorAsync(string actorType, string actorId, CancellationToken ct);

    Task RegisterReminderAsync(string actorType, string actorId, string name, TimeSpan due, TimeSpan period, CancellationToken ct);

    Task PublishAsync(string topic, object payload, CancellationToken ct);

    /// <summary>Calls sickbay's GET /demo/status; true when it reports seeded.</summary>
    Task<bool> IsSickbaySeededAsync(CancellationToken ct);

    /// <summary>Calls engineering's POST /status-report and returns a short summary.</summary>
    Task<string> GetEngineeringStatusReportAsync(CancellationToken ct);

    /// <summary>Removes this app's demo data (actor state and reminders) ahead of a reseed.</summary>
    Task ResetAsync(CancellationToken ct);
}
