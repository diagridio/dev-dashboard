"""Demo data and the seed/reset control logic (ports keep it testable without Dapr)."""

import json
import logging
import threading
import time
from typing import Optional, Protocol

log = logging.getLogger("sickbay.seed")

SCAN_WORKFLOW = "CrewHealthScan"
SCAN_INSTANCE = "medscan-001"

CREW_LOG: dict[str, dict] = {
    "crewlog-0001": {"id": "0001", "entry": "Routine physical, deck 01 bridge crew: all clear"},
    "crewlog-0002": {"id": "0002", "entry": "Minor burn treated, engineering technician"},
    "crewlog-0003": {"id": "0003", "entry": "Radiation exposure screening after warp core fluctuation"},
    "crewlog-0004": {"id": "0004", "entry": "Dizziness reported on deck 12, atmospheric pressure check requested"},
    "crewlog-0005": {"id": "0005", "entry": "Annual vaccination round completed on deck 07"},
    "crewlog-0006": {"id": "0006", "entry": "Sprained wrist, shuttle bay crew member returned to duty"},
}

ALERT_KEYS = [f"alert-RA-000{i}" for i in range(1, 5)]
RESULT_KEYS = ["result-DR-0001"]
# Fixed list: reset only ever touches these.
DEMO_KEYS = list(CREW_LOG) + ALERT_KEYS + RESULT_KEYS


class StatePort(Protocol):
    def save(self, key: str, value: str) -> None: ...
    def delete(self, key: str) -> None: ...


class WorkflowPort(Protocol):
    def ensure_started(self) -> None: ...
    def status(self, instance_id: str) -> Optional[str]: ...
    def run(self, instance_id: str) -> None: ...
    def purge(self, instance_id: str) -> None: ...


class Controller:
    """Owns the seeded flag and serializes startup seed and reset."""

    def __init__(
        self,
        state: StatePort,
        workflows: WorkflowPort,
        retry_delay: float = 1.0,
        reset_deadline: float = 120.0,
    ):
        self._state = state
        self._workflows = workflows
        self._retry_delay = retry_delay
        self._reset_deadline = reset_deadline
        self._mu = threading.Lock()  # serializes seed and every reset attempt
        self._guard = threading.Lock()  # makes request_reset's check-and-set atomic
        self._resetting = threading.Event()
        self._seeded = False
        self._last_error: Optional[str] = None

    @property
    def seeded(self) -> bool:
        return self._seeded

    def status(self) -> dict:
        body: dict = {"seeded": self._seeded}
        if self._last_error and not self._seeded:
            body["error"] = self._last_error
        return body

    def _seed(self) -> None:
        for key, value in CREW_LOG.items():
            self._state.save(key, json.dumps(value))
        self._workflows.ensure_started()
        st = self._workflows.status(SCAN_INSTANCE)
        if st == "COMPLETED":
            return
        if st is not None:
            self._workflows.purge(SCAN_INSTANCE)
        self._workflows.run(SCAN_INSTANCE)

    def seed_once(self) -> None:
        with self._mu:
            try:
                self._seed()
            except Exception as e:
                self._last_error = str(e)
                raise
            self._last_error = None
            # Same guard as request_reset's flag flip, so a reset accepted
            # right now can never be overwritten with seeded=True.
            with self._guard:
                if not self._resetting.is_set():
                    self._seeded = True

    def seed_with_retry(self, deadline: float = 120.0) -> None:
        end = time.monotonic() + deadline
        while True:
            try:
                self.seed_once()
                return
            except Exception as e:
                if time.monotonic() >= end:
                    raise
                log.info("seed attempt failed, retrying: %s", e)
                time.sleep(self._retry_delay)

    def reset_once(self) -> None:
        with self._mu:
            # A startup seed that raced the accepted reset may have stored
            # seeded=True after request_reset cleared it; clear it again.
            self._seeded = False
            try:
                self._workflows.ensure_started()
                self._workflows.purge(SCAN_INSTANCE)
                for key in DEMO_KEYS:
                    self._state.delete(key)
                self._seed()
            except Exception as e:
                self._last_error = str(e)
                raise
            self._last_error = None

    def _reset_with_retry(self) -> None:
        end = time.monotonic() + self._reset_deadline
        try:
            while True:
                try:
                    self.reset_once()
                    self._seeded = True
                    return
                except Exception as e:
                    if time.monotonic() >= end:
                        log.error("demo reset failed: %s", e)
                        return
                    log.info("reset attempt failed, retrying: %s", e)
                    time.sleep(self._retry_delay)
        finally:
            self._resetting.clear()

    def request_reset(self) -> bool:
        """Start an async reset. Returns False (no-op) when one is already in flight."""
        with self._guard:
            if self._resetting.is_set():
                return False
            self._resetting.set()
            self._seeded = False
        threading.Thread(target=self._reset_with_retry, name="demo-reset", daemon=True).start()
        return True
