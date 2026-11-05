"""Real Dapr adapters for the seed ports."""

import json
import logging
import os
import urllib.request
from typing import Optional

from dapr.clients import DaprClient
from dapr.ext.workflow import DaprWorkflowClient, WorkflowRuntime

from app import workflow

STATE_STORE = "statestore"
log = logging.getLogger("sickbay.dapr")


class DaprState:
    def __init__(self):
        self._client: Optional[DaprClient] = None

    def _c(self) -> DaprClient:
        if self._client is None:
            self._client = DaprClient()
        return self._client

    def save(self, key: str, value: str) -> None:
        self._c().save_state(STATE_STORE, key, value)

    def delete(self, key: str) -> None:
        self._c().delete_state(STATE_STORE, key)


class DaprWorkflows:
    def __init__(self):
        self._runtime: Optional[WorkflowRuntime] = None
        self._client: Optional[DaprWorkflowClient] = None

    def ensure_started(self) -> None:
        if self._runtime is not None:
            return
        runtime = WorkflowRuntime()
        workflow.register(runtime)
        try:
            runtime.start()  # raises while the sidecar is not ready; caller retries
            client = DaprWorkflowClient()
        except Exception:
            try:
                runtime.shutdown()
            except Exception as e:  # best effort; report the start failure
                log.debug("workflow runtime shutdown after failed start: %s", e)
            raise
        # Only a fully started runtime + client counts as started.
        self._client = client
        self._runtime = runtime

    def status(self, instance_id: str) -> Optional[str]:
        state = self._client.get_workflow_state(instance_id, fetch_payloads=False)
        return state.runtime_status.name if state else None

    def run(self, instance_id: str) -> None:
        self._client.schedule_new_workflow(
            workflow.crew_health_scan, input="all-decks", instance_id=instance_id
        )
        state = self._client.wait_for_workflow_completion(instance_id, timeout_in_seconds=60)
        status = state.runtime_status.name if state else None
        if status != "COMPLETED":
            raise RuntimeError(f"{instance_id} finished as {status or 'unknown'}, want COMPLETED")

    def purge(self, instance_id: str) -> None:
        if self._client.get_workflow_state(instance_id, fetch_payloads=False) is not None:
            self._client.purge_workflow(instance_id)

    def shutdown(self) -> None:
        if self._runtime is not None:
            self._runtime.shutdown()


def invoke_fleet_status() -> str:
    """Calls the starfleet-command HTTPEndpoint through the sidecar once."""
    port = os.environ.get("DAPR_HTTP_PORT", "3503")
    url = f"http://localhost:{port}/v1.0/invoke/starfleet-command/method/fleet-status"
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.dumps(json.load(r))
