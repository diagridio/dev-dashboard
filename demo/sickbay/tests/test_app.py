import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import Controller


def cloudevent(alert_id="RA-0002", subsystem="shields"):
    return {
        "specversion": "1.0",
        "id": "evt-1",
        "type": "com.dapr.event.sent",
        "source": "bridge",
        "topic": "red-alert",
        "pubsubname": "pubsub",
        "datacontenttype": "application/json",
        "data": {"alertId": alert_id, "subsystem": subsystem, "severity": "high", "message": "m"},
    }


@pytest.fixture
def client(state, workflows):
    controller = Controller(state, workflows, retry_delay=0.01)
    app = create_app(controller, state, run_startup=False)
    with TestClient(app) as c:
        yield c


def test_alert_is_idempotent(client, state):
    r1 = client.post("/alerts", json=cloudevent())
    first = state.data["alert-RA-0002"]
    r2 = client.post("/alerts", json=cloudevent())
    assert r1.json() == {"status": "SUCCESS"}
    assert r2.json() == {"status": "SUCCESS"}
    assert [k for k in state.data if k.startswith("alert-")] == ["alert-RA-0002"]
    assert state.data["alert-RA-0002"] == first
    assert state.value("alert-RA-0002")["subsystem"] == "shields"


def test_result_stored(client, state):
    ev = cloudevent()
    ev["data"] = {"id": "DR-0001", "alerts": 4, "summary": "done"}
    assert client.post("/results", json=ev).json() == {"status": "SUCCESS"}
    assert state.value("result-DR-0001")["alerts"] == 4


def test_programmatic_subscription(client):
    subs = client.get("/dapr/subscribe").json()
    assert [(s["pubsubname"], s["topic"], s["route"]) for s in subs] == [
        ("pubsub", "diagnostics.results", "/results")
    ]
    assert all(s["topic"] != "red-alert" for s in subs)


def test_status_contract(client, state):
    assert client.get("/demo/status").json() == {"seeded": False}
    client.app.state.controller.seed_once()
    assert client.get("/demo/status").json() == {"seeded": True}


def test_reset_is_202(client, state):
    c = client.app.state.controller
    c.seed_once()
    r = client.post("/demo/reset")
    assert r.status_code == 202


def test_starfleet_stub(client):
    r = client.get("/starfleet/fleet-status")
    assert r.status_code == 200
    body = r.json()
    assert body["ship"] == "Enterprise"
    assert "status" in body


def test_sickbay_loggers_emit_info(capsys):
    # Uvicorn only configures its own loggers; without this the seed and
    # starfleet-command lines never reach the Logs page.
    import logging

    from app.main import configure_logging

    configure_logging()
    logging.getLogger("sickbay.seed").info("crew log seeded")
    assert "crew log seeded" in capsys.readouterr().err
