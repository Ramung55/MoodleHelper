"""Replaceable storage boundary and process-local transactional implementation."""

from collections.abc import Callable
from copy import deepcopy
from threading import RLock
from typing import Protocol

from backend.sample_data import build_sample_snapshot
from backend.schemas import Snapshot


class SnapshotStore(Protocol):
    def read(self) -> dict: ...
    def replace(self, snapshot: dict) -> dict: ...
    def mutate(self, operation: Callable[[dict], None]) -> dict: ...


class InMemoryStore:
    """One isolated dataset per instance; no disk I/O or mutable references escape."""

    def __init__(self, snapshot: dict | None = None):
        self._lock = RLock()
        self._snapshot = self._validated(build_sample_snapshot() if snapshot is None else snapshot)

    @staticmethod
    def _validated(value: dict) -> dict:
        return Snapshot.model_validate(value).model_dump(by_alias=True, exclude_none=True)

    def read(self) -> dict:
        with self._lock:
            return deepcopy(self._snapshot)

    def replace(self, snapshot: dict) -> dict:
        next_snapshot = self._validated(snapshot)
        with self._lock:
            self._snapshot = next_snapshot
            return deepcopy(self._snapshot)

    def mutate(self, operation: Callable[[dict], None]) -> dict:
        with self._lock:
            next_snapshot = deepcopy(self._snapshot)
            operation(next_snapshot)
            self._snapshot = self._validated(next_snapshot)
            return deepcopy(self._snapshot)
