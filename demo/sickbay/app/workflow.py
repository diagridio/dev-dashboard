"""CrewHealthScan: a two-activity workflow that gives sickbay a Workflows-page entry."""

from dapr.ext.workflow import (
    DaprWorkflowContext,
    WorkflowActivityContext,
    WorkflowRuntime,
)

CREW_COUNT = 6


def scan_crew(ctx: WorkflowActivityContext, deck: str) -> dict:
    return {"deck": deck, "scanned": CREW_COUNT, "healthy": CREW_COUNT - 1, "flagged": 1}


def file_report(ctx: WorkflowActivityContext, scan: dict) -> str:
    return f"{scan['deck']}: {scan['healthy']}/{scan['scanned']} crew healthy, {scan['flagged']} flagged"


def crew_health_scan(ctx: DaprWorkflowContext, deck: str):
    scan = yield ctx.call_activity(scan_crew, input=deck or "all-decks")
    report = yield ctx.call_activity(file_report, input=scan)
    return report


def register(runtime: WorkflowRuntime) -> None:
    runtime.register_workflow(crew_health_scan, name="CrewHealthScan")
    runtime.register_activity(scan_crew, name="scan_crew")
    runtime.register_activity(file_report, name="file_report")
