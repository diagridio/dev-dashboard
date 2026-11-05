using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Bridge.Seed;

public static class Seeder
{
    public static readonly TimeSpan DefaultPollInterval = TimeSpan.FromSeconds(1);

    /// <summary>
    /// Seeds the demo: verify codes, activate actors and reminders, wait for sickbay, publish, then
    /// ask engineering for a status report. Throws TimeoutException if sickbay never becomes ready
    /// within <paramref name="deadline"/>.
    /// </summary>
    public static async Task RunAsync(ISeedPort port, TimeSpan deadline, ILogger log,
        TimeSpan? pollInterval = null, CancellationToken ct = default)
    {
        var poll = pollInterval ?? DefaultPollInterval;

        // Read to prove the secret store works; the value is never logged.
        await port.GetSecretAsync(Scenario.SecretStore, Scenario.SecretKey, ct);
        log.LogInformation("Command codes verified");

        foreach (var id in Scenario.Subsystems)
        {
            await port.ActivateActorAsync(Scenario.SubsystemActorType, id, ct);
            await port.RegisterReminderAsync(Scenario.SubsystemActorType, id, Scenario.HeartbeatReminder,
                Scenario.HeartbeatInterval, Scenario.HeartbeatInterval, ct);
        }
        foreach (var id in Scenario.Decks)
        {
            await port.ActivateActorAsync(Scenario.DeckActorType, id, ct);
        }

        await WaitForSickbayAsync(port, deadline, poll, log, ct);

        foreach (var alert in Scenario.Alerts)
        {
            await port.PublishAsync(Scenario.AlertTopic, alert, ct);
        }
        await port.PublishAsync(Scenario.ResultsTopic, Scenario.Results, ct);
        log.LogInformation("Published {Count} red alerts and diagnostics summary {Id}",
            Scenario.Alerts.Length, Scenario.Results.Id);

        try
        {
            var report = await port.GetEngineeringStatusReportAsync(ct);
            log.LogInformation("Engineering status report: {Report}", report);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Informational only; the bridge's own seed data is already in place.
            log.LogWarning("Engineering status report unavailable: {Error}", e.Message);
        }
    }

    private static async Task WaitForSickbayAsync(ISeedPort port, TimeSpan deadline, TimeSpan poll,
        ILogger log, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        string? lastError = null;
        while (true)
        {
            try
            {
                if (await port.IsSickbaySeededAsync(ct))
                {
                    return;
                }
                lastError = "reported seeded=false";
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                lastError = e.Message;
            }

            if (sw.Elapsed >= deadline)
            {
                throw new TimeoutException(
                    $"sickbay was not ready after {deadline.TotalSeconds:0.##}s (last result: {lastError})");
            }
            log.LogInformation("Waiting for sickbay to be seeded...");
            await Task.Delay(poll, ct);
        }
    }
}
