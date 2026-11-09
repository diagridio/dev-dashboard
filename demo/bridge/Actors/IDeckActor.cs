using Dapr.Actors;

namespace Bridge.Actors;

public sealed record DeckState(string Deck, string Status);

public interface IDeckActor : IActor
{
    Task InitializeAsync();

    Task<DeckState?> GetStateAsync();

    Task ResetAsync();
}
