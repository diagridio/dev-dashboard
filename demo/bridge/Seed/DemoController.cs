using Microsoft.Extensions.Logging;

namespace Bridge.Seed;

/// <summary>
/// Owns the seeded flag and the demo control contract. Seeding and every reset attempt are
/// serialized; a reset requested while one is in flight is a no-op.
/// </summary>
public sealed class DemoController
{
    private readonly ISeedPort _port;
    private readonly ILogger _log;
    private readonly TimeSpan _poll;
    private readonly SemaphoreSlim _mu = new(1, 1);
    private volatile bool _seeded;
    private volatile string? _lastError;
    private int _resetting;

    public TimeSpan SeedDeadline { get; init; } = TimeSpan.FromMinutes(2);
    public TimeSpan ResetDeadline { get; init; } = TimeSpan.FromMinutes(2);
    public TimeSpan RetryDelay { get; init; } = TimeSpan.FromSeconds(1);

    public DemoController(ISeedPort port, ILogger log, TimeSpan? pollInterval = null)
    {
        _port = port;
        _log = log;
        _poll = pollInterval ?? Seeder.DefaultPollInterval;
    }

    /// <summary>The last seed/reset error, only while not seeded.</summary>
    public (bool Seeded, string? Error) Status() => (_seeded, _seeded ? null : _lastError);

    public async Task SeedOnceAsync(CancellationToken ct)
    {
        await _mu.WaitAsync(ct);
        try
        {
            try
            {
                await Seeder.RunAsync(_port, SeedDeadline, _log, _poll, ct);
                _lastError = null;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _lastError = e.Message;
                throw;
            }
            // While a reset is pending its own reseed flips the flag.
            if (Volatile.Read(ref _resetting) == 0)
            {
                _seeded = true;
            }
        }
        finally
        {
            _mu.Release();
        }
    }

    /// <summary>Retries SeedOnceAsync until it succeeds or <paramref name="total"/> elapses.</summary>
    public async Task SeedWithRetryAsync(TimeSpan total, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(total);
        while (true)
        {
            try
            {
                await SeedOnceAsync(cts.Token);
                return;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _log.LogWarning("Seed attempt failed: {Error}", e.Message);
            }
            await Task.Delay(RetryDelay, cts.Token);
        }
    }

    /// <summary>
    /// Starts an async reset (remove demo data, reseed). Returns the running task, or null when a
    /// reset is already in flight (the caller still answers 202).
    /// </summary>
    public Task? StartReset()
    {
        if (Interlocked.CompareExchange(ref _resetting, 1, 0) != 0)
        {
            return null;
        }
        _seeded = false;
        return Task.Run(ResetWithRetryAsync);
    }

    private async Task ResetWithRetryAsync()
    {
        try
        {
            using var cts = new CancellationTokenSource(ResetDeadline);
            var ct = cts.Token;
            while (true)
            {
                await _mu.WaitAsync(ct);
                try
                {
                    await _port.ResetAsync(ct);
                    await Seeder.RunAsync(_port, SeedDeadline, _log, _poll, ct);
                    _lastError = null;
                    _seeded = true;
                    return;
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    _lastError = e.Message;
                    _log.LogWarning("Demo reset attempt failed: {Error}", e.Message);
                }
                finally
                {
                    _mu.Release();
                }
                await Task.Delay(RetryDelay, ct);
            }
        }
        catch (OperationCanceledException)
        {
            _lastError ??= "reset timed out";
            _log.LogError("Demo reset gave up: {Error}", _lastError);
        }
        finally
        {
            Volatile.Write(ref _resetting, 0);
        }
    }
}
