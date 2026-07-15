using Dapr.Workflow;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDaprWorkflow(options =>
{
    options.RegisterWorkflow<OrderWorkflow>();
    options.RegisterActivity<NotifyActivity>();
});

var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok());

// Schedule one workflow instance once the sidecar is ready.
_ = Task.Run(async () =>
{
    using var scope = app.Services.CreateScope();
    var client = scope.ServiceProvider.GetRequiredService<DaprWorkflowClient>();
    for (var i = 0; i < 30; i++)
    {
        try
        {
            await client.ScheduleNewWorkflowAsync(
                name: nameof(OrderWorkflow),
                instanceId: "e2e-order-1",
                input: "order");
            break;
        }
        catch
        {
            await Task.Delay(TimeSpan.FromSeconds(2));
        }
    }
});

app.Run();

sealed class OrderWorkflow : Workflow<string, string>
{
    public override async Task<string> RunAsync(WorkflowContext context, string input)
        => await context.CallActivityAsync<string>(nameof(NotifyActivity), input);
}

sealed class NotifyActivity : WorkflowActivity<string, string>
{
    public override Task<string> RunAsync(WorkflowActivityContext context, string input)
        => Task.FromResult($"notified:{input}");
}
