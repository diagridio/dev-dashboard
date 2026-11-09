using System.Reflection;
using Bridge.Actors;
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
    public override Task RegisterReminderAsync(ActorReminder reminder) => Task.CompletedTask;
    public override Task UnregisterReminderAsync(ActorReminderToken reminder) => Task.CompletedTask;
    public override Task<IActorReminder> GetReminderAsync(ActorReminderToken reminder) =>
        Task.FromResult<IActorReminder>(null!);
}

public class SubsystemActorTests
{
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
}
