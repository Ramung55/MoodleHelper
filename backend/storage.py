"""Replaceable storage boundary and process-local transactional implementation."""

from collections.abc import Callable
from copy import deepcopy
from threading import RLock
from typing import Protocol

from backend.sample_data import build_sample_snapshot
from backend.schemas import Snapshot
from backend import schemas
from backend.domain_validation import merge_source_evidence, validate_record


class SnapshotStore(Protocol):
    def read(self) -> dict: ...
    def replace(self, snapshot: dict) -> dict: ...
    def mutate(self, operation: Callable[[dict], None]) -> dict: ...


class SourceUpserts:
    """Stable dataset-local IDs, never title matching or whole-Snapshot restore."""

    def upsert_source(self, collection: str, record: dict) -> dict:
        models = {"courses": schemas.Course, "assessments": schemas.Assessment, "materials": schemas.Material}
        if collection not in models:
            raise ValueError("source upsert requires courses, assessments or materials")
        incoming = validate_record(models[collection], record)
        if collection == "assessments" and incoming["personal"]:
            raise ValueError("source upsert cannot write personal events")
        if collection == "assessments":
            incoming["sources"] = merge_source_evidence([], incoming["sources"])

        def apply(snapshot):
            existing = next((item for item in snapshot[collection] if item["id"] == incoming["id"]), None)
            if existing is None:
                snapshot[collection].append(deepcopy(incoming))
            else:
                if collection == "assessments":
                    if existing["personal"]:
                        raise ValueError("source upsert cannot replace a personal event")
                    incoming["sources"] = merge_source_evidence(existing["sources"], incoming["sources"])
                    incoming["firstObservedAt"] = existing["firstObservedAt"]
                if collection == "materials" and "downloadedAt" in existing:
                    incoming["downloadedAt"] = existing["downloadedAt"]
                existing.clear()
                existing.update(deepcopy(incoming))
        return self.mutate(apply)


class InMemoryStore(SourceUpserts):
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
