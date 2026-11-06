using Dapr.Actors;

namespace Bridge.Actors;

public sealed record SubsystemState(string Status, DateTimeOffset LastCheck);

public interface ISubsystemActor : IActor
{
    /// <summary>Stores the initial state (idempotent) so the actor shows up with data.</summary>
    Task InitializeAsync();

    Task<SubsystemState?> GetStateAsync();

    /// <summary>Registers the diagnostic-heartbeat reminder (due 24 h, period 24 h). Idempotent.</summary>
    Task RegisterHeartbeatAsync();

    /// <summary>Clears state and unregisters the reminder.</summary>
    Task ResetAsync();
}
