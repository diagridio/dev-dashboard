using System.Text.Json;
using Bridge.Seed;
using Dapr.Actors.Runtime;

namespace Bridge.Actors;

public sealed class SubsystemActor(ActorHost host) : Actor(host), ISubsystemActor, IRemindable
{
    private const string StateKey = "state";

    /// <summary>Actor timer name; due 24 h, period 24 h so it never fires during a session.</summary>
    public const string StatusPollTimer = "status-poll";
    public static readonly TimeSpan StatusPollInterval = TimeSpan.FromHours(24);

    protected override async Task OnActivateAsync()
    {
        // Registering a timer under the same name replaces it, so this is idempotent.
        await RegisterTimerAsync(StatusPollTimer, nameof(PollStatusAsync), null,
            StatusPollInterval, StatusPollInterval);
    }

    /// <summary>Timer callback: just logs; the heartbeat reminder owns the state.</summary>
    public Task PollStatusAsync()
    {
        Logger.LogInformation("Subsystem {Id} status poll", Id);
        return Task.CompletedTask;
    }

    public async Task InitializeAsync()
    {
        // Keep existing state so reseeding never clobbers a heartbeat result.
        if (!(await StateManager.ContainsStateAsync(StateKey)))
        {
            await StateManager.SetStateAsync(StateKey, new SubsystemState("nominal", DateTimeOffset.UtcNow));
        }
    }

    public async Task<SubsystemState?> GetStateAsync()
    {
        var cond = await StateManager.TryGetStateAsync<SubsystemState>(StateKey);
        return cond.HasValue ? cond.Value : null;
    }

    public async Task<SubsystemState> SetPowerLevelAsync(PowerRequest request)
    {
        if (request.Level is < 0 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(request), "Level must be between 0 and 100.");
        }
        var current = await GetStateAsync() ?? new SubsystemState("nominal", DateTimeOffset.UtcNow);
        var updated = current with { PowerLevel = request.Level };
        await StateManager.SetStateAsync(StateKey, updated);
        await StateManager.SaveStateAsync();
        return updated;
    }

    public async Task RegisterHeartbeatAsync()
    {
        await RegisterReminderAsync(Scenario.HeartbeatReminder,
            JsonSerializer.SerializeToUtf8Bytes(new { subsystem = Id.GetId() }),
            Scenario.HeartbeatInterval, Scenario.HeartbeatInterval);
    }

    public async Task ResetAsync()
    {
        await StateManager.TryRemoveStateAsync(StateKey);
        await StateManager.SaveStateAsync();
        try
        {
            await UnregisterReminderAsync(Scenario.HeartbeatReminder);
        }
        catch (Exception)
        {
            // Not registered yet; nothing to remove.
        }
    }

    public async Task ReceiveReminderAsync(string reminderName, byte[] state, TimeSpan dueTime, TimeSpan period)
    {
        if (reminderName != Scenario.HeartbeatReminder)
        {
            return;
        }
        await StateManager.SetStateAsync(StateKey, new SubsystemState("nominal", DateTimeOffset.UtcNow));
    }
}
