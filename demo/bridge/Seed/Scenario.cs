namespace Bridge.Seed;

public sealed record AlertMessage(string AlertId, string Subsystem, string Severity, string Message);

public sealed record DiagnosticsSummary(string Id, int Alerts, string Summary);

/// <summary>The fixed demo data.</summary>
public static class Scenario
{
    public const string SecretStore = "command-codes";
    public const string SecretKey = "warp-override-code";
    public const string HeartbeatReminder = "diagnostic-heartbeat";
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromHours(24);

    public const string SubsystemActorType = "SubsystemActor";
    public const string DeckActorType = "DeckActor";
    public const string AlertTopic = "red-alert";
    public const string ResultsTopic = "diagnostics.results";

    public static readonly string[] Subsystems = ["warp-core", "shields", "deflector", "life-support"];
    public static readonly string[] Decks = ["deck-01", "deck-07", "deck-12"];

    public static readonly AlertMessage[] Alerts =
    [
        new("RA-0001", "warp-core", "critical", "Warp core containment fluctuation detected"),
        new("RA-0002", "shields", "high", "Forward shield harmonics out of tolerance"),
        new("RA-0003", "deflector", "medium", "Deflector dish alignment drift"),
        new("RA-0004", "life-support", "high", "Deck 12 atmospheric pressure below threshold"),
    ];

    public static readonly DiagnosticsSummary Results =
        new("DR-0001", Alerts.Length, "Level 1 diagnostics complete; 4 anomalies raised");
}
