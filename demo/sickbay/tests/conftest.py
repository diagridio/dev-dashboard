import json

import pytest


class FakeState:
    def __init__(self):
        self.data: dict[str, str] = {}
        self.fail_next = 0

    def save(self, key: str, value: str) -> None:
        if self.fail_next:
            self.fail_next -= 1
            raise RuntimeError("sidecar not ready")
        self.data[key] = value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)

    def value(self, key: str):
        return json.loads(self.data[key])


class FakeWorkflows:
    def __init__(self):
        self.statuses: dict[str, str] = {}
        self.events: list[tuple[str, str]] = []

    def ensure_started(self) -> None:
        self.events.append(("start", ""))

    def status(self, instance_id: str):
        return self.statuses.get(instance_id)

    def run(self, instance_id: str) -> None:
        self.events.append(("run", instance_id))
        self.statuses[instance_id] = "COMPLETED"

    def purge(self, instance_id: str) -> None:
        self.events.append(("purge", instance_id))
        self.statuses.pop(instance_id, None)


@pytest.fixture
def state():
    return FakeState()


@pytest.fixture
def workflows():
    return FakeWorkflows()
