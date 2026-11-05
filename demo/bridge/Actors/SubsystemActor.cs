using Bridge.Seed;
using Dapr.Actors.Runtime;

namespace Bridge.Actors;

public sealed class SubsystemActor(ActorHost host) : Actor(host), ISubsystemActor, IRemindable
{
    private const string StateKey = "state";

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

    public async Task RegisterHeartbeatAsync()
    {
        await RegisterReminderAsync(Scenario.HeartbeatReminder, null,
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
