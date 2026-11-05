using Bridge.Seed;
using Microsoft.Extensions.Logging.Abstractions;

namespace Bridge.Tests;

internal sealed class FakePort : ISeedPort
{
    public readonly List<string> Calls = [];
    public readonly List<(string Type, string Id, string Name)> Reminders = [];
    public readonly List<(string Topic, object Payload)> Published = [];
    public int SickbayPolls;
    public int NotReadyPolls = 2; // number of seeded:false answers before true (-1 = never)
    public Func<CancellationToken, Task>? ResetHook;
    public string? SecretReturned;

    public Task<string> GetSecretAsync(string store, string key, CancellationToken ct)
    {
        Calls.Add($"secret:{store}/{key}");
        SecretReturned = "NCC-DEMO-0000";
        return Task.FromResult(SecretReturned);
    }

    public Task ActivateActorAsync(string actorType, string actorId, CancellationToken ct)
    {
        Calls.Add($"activate:{actorType}/{actorId}");
        return Task.CompletedTask;
    }

    public Task RegisterReminderAsync(string actorType, string actorId, string name, TimeSpan due, TimeSpan period, CancellationToken ct)
    {
        Reminders.Add((actorType, actorId, name));
        Assert.Equal(TimeSpan.FromHours(24), due);
        Assert.Equal(TimeSpan.FromHours(24), period);
        return Task.CompletedTask;
    }

    public Task PublishAsync(string topic, object payload, CancellationToken ct)
    {
        Published.Add((topic, payload));
        Calls.Add($"publish:{topic}");
        return Task.CompletedTask;
    }

    public Task<bool> IsSickbaySeededAsync(CancellationToken ct)
    {
        SickbayPolls++;
        Calls.Add("poll");
        return Task.FromResult(NotReadyPolls >= 0 && SickbayPolls > NotReadyPolls);
    }

    public Task<string> GetEngineeringStatusReportAsync(CancellationToken ct)
    {
        Calls.Add("engineering");
        return Task.FromResult("sweep-001=RUNNING");
    }

    public Task ResetAsync(CancellationToken ct)
    {
        Calls.Add("reset");
        return ResetHook?.Invoke(ct) ?? Task.CompletedTask;
    }
}

public class SeederTests
{
    private static readonly TimeSpan Fast = TimeSpan.FromMilliseconds(5);

    [Fact]
    public async Task Seed_WaitsForSickbayBeforePublishing()
    {
        var port = new FakePort();
        await Seeder.RunAsync(port, TimeSpan.FromSeconds(5), NullLogger.Instance, Fast);

        Assert.Equal(3, port.SickbayPolls);
        var firstPublish = port.Calls.FindIndex(c => c.StartsWith("publish:"));
        var thirdPoll = port.Calls.FindIndexOf("poll", 3);
        Assert.True(thirdPoll < firstPublish, "no publish before the third (ready) poll");
    }

    [Fact]
    public async Task Seed_PublishesFixedAlerts()
    {
        var port = new FakePort { NotReadyPolls = 0 };
        await Seeder.RunAsync(port, TimeSpan.FromSeconds(5), NullLogger.Instance, Fast);

        var alerts = port.Published.Where(p => p.Topic == "red-alert").Select(p => ((AlertMessage)p.Payload).AlertId);
        Assert.Equal(["RA-0001", "RA-0002", "RA-0003", "RA-0004"], alerts);
        var results = port.Published.Where(p => p.Topic == "diagnostics.results").ToList();
        Assert.Single(results);
        Assert.Equal("DR-0001", ((DiagnosticsSummary)results[0].Payload).Id);
        Assert.Equal(5, port.Published.Count);
        Assert.Contains("engineering", port.Calls);
    }

    [Fact]
    public async Task Seed_IsIdempotent()
    {
        var port = new FakePort { NotReadyPolls = 0 };
        await Seeder.RunAsync(port, TimeSpan.FromSeconds(5), NullLogger.Instance, Fast);
        var first = port.Reminders.ToList();
        await Seeder.RunAsync(port, TimeSpan.FromSeconds(5), NullLogger.Instance, Fast);

        var distinct = port.Reminders.Distinct().ToList();
        Assert.Equal(first.Count, distinct.Count);
        Assert.Equal(first.OrderBy(x => x.Id), distinct.OrderBy(x => x.Id));
        Assert.All(distinct, r => Assert.Equal("diagnostic-heartbeat", r.Name));
        Assert.Equal(["deflector", "life-support", "shields", "warp-core"], distinct.Select(r => r.Id).Order());
    }

    [Fact]
    public async Task Seed_TimesOutWithClearError()
    {
        var port = new FakePort { NotReadyPolls = -1 };
        var ex = await Assert.ThrowsAsync<TimeoutException>(() =>
            Seeder.RunAsync(port, TimeSpan.FromMilliseconds(50), NullLogger.Instance, Fast));
        Assert.Contains("sickbay", ex.Message);
        Assert.Empty(port.Published);
    }
}

internal static class ListExt
{
    /// <summary>Index of the nth (1-based) occurrence of value.</summary>
    public static int FindIndexOf(this List<string> list, string value, int nth)
    {
        var seen = 0;
        for (var i = 0; i < list.Count; i++)
        {
            if (list[i] == value && ++seen == nth) return i;
        }
        return -1;
    }
}
