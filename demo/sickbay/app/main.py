"""sickbay: Enterprise medical bay (FastAPI + Dapr)."""

import json
import logging
import sys
import threading
from contextlib import asynccontextmanager
from typing import Any, Optional

from dapr.ext.fastapi import DaprApp
from fastapi import Body, FastAPI, Response

from app.seed import Controller, StatePort

log = logging.getLogger("sickbay")


def configure_logging() -> None:
    """Send the app's own INFO logs to stderr (uvicorn only configures its loggers)."""
    for h in list(log.handlers):
        if getattr(h, "_sickbay", False):
            log.removeHandler(h)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    handler._sickbay = True  # type: ignore[attr-defined]
    log.addHandler(handler)
    log.setLevel(logging.INFO)

SUCCESS = {"status": "SUCCESS"}
DROP = {"status": "DROP"}


def create_app(
    controller: Optional[Controller] = None,
    state: Optional[StatePort] = None,
    run_startup: bool = True,
    on_seeded=None,
) -> FastAPI:
    workflows = None
    if controller is None:
        from app.dapr_ports import DaprState, DaprWorkflows

        state = state or DaprState()
        workflows = DaprWorkflows()
        controller = Controller(state, workflows)
    assert state is not None

    def startup_seed():
        try:
            controller.seed_with_retry(deadline=120)
        except Exception as e:
            log.error("startup seed failed: %s", e)
            return
        if on_seeded:
            on_seeded()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if run_startup:
            threading.Thread(target=startup_seed, name="startup-seed", daemon=True).start()
        yield
        if workflows is not None:
            workflows.shutdown()

    def _store(event, id_field: str, prefix: str, topic: str) -> dict:
        # A malformed message (e.g. the Publish dialog's default "{}") is
        # dropped, not failed: a 500 would make Dapr redeliver it forever.
        data = event.get("data") if isinstance(event, dict) else None
        key = data.get(id_field) if isinstance(data, dict) else None
        if not isinstance(key, str) or not key:
            log.warning("dropping %s message without data.%s: %r", topic, id_field, data)
            return DROP
        state.save(f"{prefix}-{key}", json.dumps(data, sort_keys=True))
        return SUCCESS

    app = FastAPI(title="sickbay", lifespan=lifespan)
    app.state.controller = controller
    dapr_app = DaprApp(app)

    # Declarative subscription red-alert-sub delivers red-alert here.
    @app.post("/alerts")
    def alerts(event: Any = Body(None)):
        return _store(event, "alertId", "alert", "red-alert")

    # Programmatic subscription.
    @dapr_app.subscribe(pubsub="pubsub", topic="diagnostics.results", route="/results")
    def results(event: Any = Body(None)):
        return _store(event, "id", "result", "diagnostics.results")

    @app.get("/demo/status")
    def demo_status():
        return controller.status()

    @app.post("/demo/reset", status_code=202)
    def demo_reset():
        controller.request_reset()
        return Response(status_code=202)

    # Target of the starfleet-command HTTPEndpoint.
    @app.get("/starfleet/fleet-status")
    def fleet_status():
        return {"ship": "Enterprise", "status": "nominal", "fleet": {"ships": 12, "alerts": 0}}

    return app


def _log_fleet_status():
    from app.dapr_ports import invoke_fleet_status

    try:
        log.info("starfleet-command fleet-status: %s", invoke_fleet_status())
    except Exception as e:
        log.warning("starfleet-command call failed: %s", e)


configure_logging()
app = create_app(on_seeded=_log_fleet_status)
