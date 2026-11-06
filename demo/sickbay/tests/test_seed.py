import threading
import time

import pytest

from app.seed import ALERT_KEYS, CREW_LOG, DEMO_KEYS, SCAN_INSTANCE, Controller


def make(state, workflows, **kw):
    return Controller(state, workflows, retry_delay=0.01, **kw)


def test_seed_writes_crewlog(state, workflows):
    c = make(state, workflows)
    c.seed_once()
    keys = sorted(k for k in state.data if k.startswith("crewlog-"))
    assert keys == [f"crewlog-000{i}" for i in range(1, 7)]
    first = dict(state.data)
    c.seed_once()
    assert state.data == first
    assert workflows.statuses[SCAN_INSTANCE] == "COMPLETED"
    assert c.seeded is True


def test_seed_does_not_rerun_completed_scan(state, workflows):
    c = make(state, workflows)
    c.seed_once()
    c.seed_once()
    assert workflows.events.count(("run", SCAN_INSTANCE)) == 1


def test_reset_deletes_only_demo_keys(state, workflows):
    c = make(state, workflows)
    c.seed_once()
    for k in ALERT_KEYS + ["result-DR-0001"]:
        state.save(k, "{}")
    state.save("unrelated", "keep")
    state.save("alert-RA-9999", "keep")
    deleted = []
    orig = state.delete
    state.delete = lambda k: (deleted.append(k), orig(k))[1]

    c.reset_once()

    assert sorted(deleted) == sorted(DEMO_KEYS)
    assert set(DEMO_KEYS) == {k for k in CREW_LOG} | {
        "alert-RA-0001", "alert-RA-0002", "alert-RA-0003", "alert-RA-0004", "result-DR-0001"
    }
    assert state.data["unrelated"] == "keep"
    assert state.data["alert-RA-9999"] == "keep"
    assert "alert-RA-0001" not in state.data
    # purge happened before the rerun
    ev = workflows.events
    assert ev.index(("purge", SCAN_INSTANCE)) < len(ev) - 1 - ev[::-1].index(("run", SCAN_INSTANCE))
    assert len(state.data) == 6 + 2  # crew log + unrelated entries, reseeded


def test_status_contract_and_error(state, workflows):
    c = make(state, workflows)
    assert c.status() == {"seeded": False}
    state.fail_next = 1
    with pytest.raises(RuntimeError):
        c.seed_once()
    assert c.status() == {"seeded": False, "error": "sidecar not ready"}
    c.seed_once()
    assert c.status() == {"seeded": True}


def test_seed_retries_until_ready(state, workflows):
    c = make(state, workflows)
    state.fail_next = 3
    c.seed_with_retry(deadline=5)
    assert c.seeded is True


def test_seed_retry_gives_up_at_deadline(state, workflows):
    c = make(state, workflows)
    state.fail_next = 10_000
    with pytest.raises(RuntimeError):
        c.seed_with_retry(deadline=0.1)
    assert c.seeded is False
    assert "error" in c.status()


def test_reset_retries_and_stays_unseeded_until_done(state, workflows):
    c = make(state, workflows)
    c.seed_once()
    gate = threading.Event()
    orig = workflows.purge

    def slow_purge(i):
        gate.wait(2)
        orig(i)

    workflows.purge = slow_purge
    assert c.request_reset() is True
    assert c.seeded is False
    # second reset while in flight is a no-op
    assert c.request_reset() is False
    gate.set()
    for _ in range(200):
        if c.seeded:
            break
        time.sleep(0.01)
    assert c.seeded is True
    assert workflows.events.count(("run", SCAN_INSTANCE)) == 2
    assert c.request_reset() is True  # allowed again after completion


def test_reset_retries_on_failure(state, workflows):
    c = make(state, workflows)
    c.seed_once()
    state.fail_next = 2  # reseed saves fail twice
    c.request_reset()
    for _ in range(300):
        if c.seeded:
            break
        time.sleep(0.01)
    assert c.seeded is True


def test_racy_seed_store_is_cleared_when_reset_worker_starts(state, workflows):
    # Simulate a startup seed that stored seeded=True after the reset was
    # accepted: the reset worker must re-clear it before doing its work.
    c = make(state, workflows)
    gate = threading.Event()
    orig = workflows.purge

    def slow_purge(i):
        gate.wait(2)
        orig(i)

    workflows.purge = slow_purge
    with c._mu:  # the startup seed still holds the lock
        assert c.request_reset() is True
        c._seeded = True  # the racy store
    for _ in range(200):
        if not c.seeded:
            break
        time.sleep(0.005)
    assert c.seeded is False  # worker re-cleared it while it works
    gate.set()
    for _ in range(200):
        if c.seeded:
            break
        time.sleep(0.01)
    assert c.seeded is True


def test_seed_check_and_store_share_the_reset_guard(state, workflows):
    c = make(state, workflows)
    # While request_reset's guard is held, seed_once cannot store the flag.
    done = threading.Event()
    with c._guard:
        t = threading.Thread(target=lambda: (c.seed_once(), done.set()))
        t.start()
        assert not done.wait(0.1)
        assert c.seeded is False
        c._resetting.set()  # the reset that held the guard was accepted
    t.join(2)
    assert done.is_set()
    assert c.seeded is False
