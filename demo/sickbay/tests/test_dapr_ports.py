"""DaprWorkflows adapter behaviour, with the SDK runtime/client faked out."""

from types import SimpleNamespace

import pytest

from app import dapr_ports


class FakeRuntime:
    instances: list["FakeRuntime"] = []
    fail_start = False

    def __init__(self):
        self.started = False
        self.shut_down = False
        FakeRuntime.instances.append(self)

    def register_workflow(self, *a, **kw):
        pass

    def register_activity(self, *a, **kw):
        pass

    def start(self):
        if FakeRuntime.fail_start:
            raise RuntimeError("sidecar not ready")
        self.started = True

    def shutdown(self):
        self.shut_down = True


class FakeClient:
    final_status = "COMPLETED"
    fail_init = False

    def __init__(self):
        if FakeClient.fail_init:
            raise RuntimeError("no client")

    def schedule_new_workflow(self, *a, **kw):
        pass

    def wait_for_workflow_completion(self, instance_id, timeout_in_seconds=0):
        return SimpleNamespace(runtime_status=SimpleNamespace(name=FakeClient.final_status))


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakeRuntime.instances, FakeRuntime.fail_start = [], False
    FakeClient.final_status, FakeClient.fail_init = "COMPLETED", False
    monkeypatch.setattr(dapr_ports, "WorkflowRuntime", FakeRuntime)
    monkeypatch.setattr(dapr_ports, "DaprWorkflowClient", FakeClient)
    monkeypatch.setattr(dapr_ports.workflow, "register", lambda rt: None)


def test_failed_start_shuts_runtime_down_and_stays_unstarted():
    wf = dapr_ports.DaprWorkflows()
    FakeRuntime.fail_start = True
    with pytest.raises(RuntimeError):
        wf.ensure_started()
    assert FakeRuntime.instances[0].shut_down is True
    assert wf._runtime is None
    # The retry builds a fresh runtime.
    FakeRuntime.fail_start = False
    wf.ensure_started()
    assert len(FakeRuntime.instances) == 2 and wf._runtime is FakeRuntime.instances[1]


def test_client_failure_does_not_mark_started():
    wf = dapr_ports.DaprWorkflows()
    FakeClient.fail_init = True
    with pytest.raises(RuntimeError):
        wf.ensure_started()
    assert wf._runtime is None and wf._client is None
    assert FakeRuntime.instances[0].shut_down is True


def test_run_raises_when_scan_did_not_complete():
    wf = dapr_ports.DaprWorkflows()
    wf.ensure_started()
    FakeClient.final_status = "FAILED"
    with pytest.raises(RuntimeError, match="FAILED"):
        wf.run("medscan-001")
    FakeClient.final_status = "COMPLETED"
    wf.run("medscan-001")


def test_controller_stays_unseeded_on_failed_scan(state):
    from app.seed import Controller

    wf = dapr_ports.DaprWorkflows()
    wf.status = lambda _id: None
    FakeClient.final_status = "FAILED"
    c = Controller(state, wf, retry_delay=0.01)
    with pytest.raises(RuntimeError):
        c.seed_once()
    assert c.seeded is False
    assert "FAILED" in c.status()["error"]
