using System.Reflection;
using Bridge.Actors;
using Dapr.Actors;
using Dapr.Actors.Runtime;

namespace Bridge.Tests;

internal sealed class FakeTimerManager : ActorTimerManager
{
    public readonly List<ActorTimer> Timers = [];

    public override Task RegisterTimerAsync(ActorTimer timer)
    {
        Timers.RemoveAll(t => t.Name == timer.Name); // same name replaces, like the runtime
        Timers.Add(timer);
        return Task.CompletedTask;
    }

    public override Task UnregisterTimerAsync(ActorTimerToken timer) => Task.CompletedTask;
    public readonly List<ActorReminder> Reminders = [];

    public override Task RegisterReminderAsync(ActorReminder reminder)
    {
        Reminders.Add(reminder);
        return Task.CompletedTask;
    }

    public override Task UnregisterReminderAsync(ActorReminderToken reminder) => Task.CompletedTask;
    public override Task<IActorReminder> GetReminderAsync(ActorReminderToken reminder) =>
        Task.FromResult<IActorReminder>(null!);
}

internal sealed class FakeStateManager : IActorStateManager
{
    private readonly Dictionary<string, object?> _values = new();

    public Task<bool> ContainsStateAsync(string stateName, CancellationToken ct = default) =>
        Task.FromResult(_values.ContainsKey(stateName));

    public Task SetStateAsync<T>(string stateName, T value, CancellationToken ct = default)
    {
        _values[stateName] = value;
        return Task.CompletedTask;
    }

    public Task<ConditionalValue<T>> TryGetStateAsync<T>(string stateName, CancellationToken ct = default) =>
        Task.FromResult(_values.TryGetValue(stateName, out var v)
            ? new ConditionalValue<T>(true, (T)v!)
            : new ConditionalValue<T>(false, default!));

    public Task<bool> TryRemoveStateAsync(string stateName, CancellationToken ct = default) =>
        Task.FromResult(_values.Remove(stateName));

    public Task SaveStateAsync(CancellationToken ct = default) => Task.CompletedTask;

    public Task AddStateAsync<T>(string stateName, T value, CancellationToken ct = default) => throw new NotImplementedException();
    public Task AddStateAsync<T>(string stateName, T value, TimeSpan ttl, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<T> GetStateAsync<T>(string stateName, CancellationToken ct = default) => throw new NotImplementedException();
    public Task SetStateAsync<T>(string stateName, T value, TimeSpan ttl, CancellationToken ct = default) => throw new NotImplementedException();
    public Task RemoveStateAsync(string stateName, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> TryAddStateAsync<T>(string stateName, T value, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<bool> TryAddStateAsync<T>(string stateName, T value, TimeSpan ttl, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<T> GetOrAddStateAsync<T>(string stateName, T value, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<T> GetOrAddStateAsync<T>(string stateName, T value, TimeSpan ttl, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<T> AddOrUpdateStateAsync<T>(string stateName, T addValue, Func<string, T, T> updateValueFactory, CancellationToken ct = default) => throw new NotImplementedException();
    public Task<T> AddOrUpdateStateAsync<T>(string stateName, T addValue, Func<string, T, T> updateValueFactory, TimeSpan ttl, CancellationToken ct = default) => throw new NotImplementedException();
    public Task ClearCacheAsync(CancellationToken ct = default) => throw new NotImplementedException();
    public Task UnloadStateAsync(string stateName, UnloadStateOptions options, CancellationToken ct = default) => throw new NotImplementedException();
}

public class SubsystemActorTests
{
    private static SubsystemActor NewActorWithState()
    {
        var actor = new SubsystemActor(ActorHost.CreateForTest<SubsystemActor>());
        typeof(Actor).GetProperty("StateManager")!.SetValue(actor, new FakeStateManager());
        return actor;
    }

    private static Task Activate(Actor actor) =>
        (Task)typeof(Actor).GetMethod("OnActivateAsync", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(actor, null)!;

    [Fact]
    public async Task Activation_RegistersStatusPollTimer_Idempotently()
    {
        var timers = new FakeTimerManager();
        var host = ActorHost.CreateForTest<SubsystemActor>(new ActorTestOptions { TimerManager = timers });
        var actor = new SubsystemActor(host);

        await Activate(actor);
        await Activate(actor);

        var t = Assert.Single(timers.Timers);
        Assert.Equal("status-poll", t.Name);
        Assert.Equal(nameof(SubsystemActor.PollStatusAsync), t.TimerCallback);
        Assert.Equal(TimeSpan.FromHours(24), t.DueTime);
        Assert.Equal(TimeSpan.FromHours(24), t.Period);
    }

    [Fact]
    public async Task SetPowerLevel_StoresLevel()
    {
        var actor = NewActorWithState();
        await actor.InitializeAsync();

        var result = await actor.SetPowerLevelAsync(new PowerRequest(80));

        Assert.Equal(80, result.PowerLevel);
        Assert.Equal("nominal", result.Status);
        var stored = await actor.GetStateAsync();
        Assert.Equal(80, stored!.PowerLevel);
        Assert.Equal("nominal", stored.Status);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(101)]
    public async Task SetPowerLevel_RejectsOutOfRange(int level)
    {
        var actor = NewActorWithState();
        await actor.InitializeAsync();

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => actor.SetPowerLevelAsync(new PowerRequest(level)));

        Assert.Equal(100, (await actor.GetStateAsync())!.PowerLevel);
    }

    [Fact]
    public async Task RegisterHeartbeat_SendsSubsystemData()
    {
        var timers = new FakeTimerManager();
        var host = ActorHost.CreateForTest<SubsystemActor>(
            new ActorTestOptions { TimerManager = timers, ActorId = new ActorId("shields") });
        var actor = new SubsystemActor(host);

        await actor.RegisterHeartbeatAsync();

        var r = Assert.Single(timers.Reminders);
        var doc = System.Text.Json.JsonDocument.Parse(r.State);
        Assert.Equal("shields", doc.RootElement.GetProperty("subsystem").GetString());
    }
}
