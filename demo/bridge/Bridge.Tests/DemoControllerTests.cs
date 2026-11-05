using Bridge.Seed;
using Microsoft.Extensions.Logging.Abstractions;

namespace Bridge.Tests;

public class DemoControllerTests
{
    private static readonly TimeSpan Fast = TimeSpan.FromMilliseconds(5);

    private static DemoController Make(FakePort port) =>
        new(port, NullLogger.Instance, Fast) { RetryDelay = Fast, SeedDeadline = TimeSpan.FromSeconds(2), ResetDeadline = TimeSpan.FromSeconds(5) };

    [Fact]
    public async Task Status_FalseUntilSeeded_ThenTrue()
    {
        var demo = Make(new FakePort { NotReadyPolls = 0 });
        Assert.Equal((false, null), demo.Status());
        await demo.SeedOnceAsync(CancellationToken.None);
        Assert.Equal((true, null), demo.Status());
    }

    [Fact]
    public async Task SeedFailure_SurfacesErrorAndStaysUnseeded()
    {
        var demo = new DemoController(new FakePort { NotReadyPolls = -1 }, NullLogger.Instance, Fast)
        { SeedDeadline = TimeSpan.FromMilliseconds(30) };
        await Assert.ThrowsAsync<TimeoutException>(() => demo.SeedOnceAsync(CancellationToken.None));
        var (seeded, error) = demo.Status();
        Assert.False(seeded);
        Assert.Contains("sickbay", error);
    }

    [Fact]
    public async Task Reset_SeededStaysFalseUntilReseedFinishes_AndSecondResetIsNoOp()
    {
        var gate = new TaskCompletionSource();
        var port = new FakePort { NotReadyPolls = 0, ResetHook = _ => gate.Task };
        var demo = Make(port);
        await demo.SeedOnceAsync(CancellationToken.None);
        Assert.True(demo.Status().Seeded);

        var running = demo.StartReset();
        Assert.NotNull(running);
        Assert.False(demo.Status().Seeded);
        Assert.Null(demo.StartReset()); // in flight: no-op

        gate.SetResult();
        await running!;
        Assert.True(demo.Status().Seeded);
        Assert.Equal(1, port.Calls.Count(c => c == "reset"));
        // a new reset is allowed again once the first has finished
        Assert.NotNull(demo.StartReset());
    }

    [Fact]
    public async Task Reset_RetriesAfterFailure()
    {
        var attempts = 0;
        var port = new FakePort
        {
            NotReadyPolls = 0,
            ResetHook = _ => ++attempts < 3 ? Task.FromException(new InvalidOperationException("sidecar not ready")) : Task.CompletedTask,
        };
        var demo = Make(port);
        await demo.StartReset()!;
        Assert.Equal(3, attempts);
        Assert.True(demo.Status().Seeded);
    }

    [Fact]
    public async Task Reset_GivesUpAtDeadline_WithError()
    {
        var port = new FakePort
        {
            NotReadyPolls = 0,
            ResetHook = _ => Task.FromException(new InvalidOperationException("boom")),
        };
        var demo = new DemoController(port, NullLogger.Instance, Fast)
        { RetryDelay = Fast, ResetDeadline = TimeSpan.FromMilliseconds(80) };
        await demo.StartReset()!;
        var (seeded, error) = demo.Status();
        Assert.False(seeded);
        Assert.Equal("boom", error);
    }
}
