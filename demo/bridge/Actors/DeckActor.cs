using Dapr.Actors.Runtime;

namespace Bridge.Actors;

public sealed class DeckActor(ActorHost host) : Actor(host), IDeckActor
{
    private const string StateKey = "state";

    public async Task InitializeAsync()
    {
        if (!(await StateManager.ContainsStateAsync(StateKey)))
        {
            await StateManager.SetStateAsync(StateKey, new DeckState(Id.GetId(), "secure"));
        }
    }

    public async Task<DeckState?> GetStateAsync()
    {
        var cond = await StateManager.TryGetStateAsync<DeckState>(StateKey);
        return cond.HasValue ? cond.Value : null;
    }

    public async Task ResetAsync()
    {
        await StateManager.TryRemoveStateAsync(StateKey);
        await StateManager.SaveStateAsync();
    }
}
