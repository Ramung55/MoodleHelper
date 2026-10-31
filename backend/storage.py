"""Replaceable Snapshot boundary, source upserts and explicit memory fixture store."""

from collections.abc import Callable
from copy import deepcopy
from threading import RLock
from typing import Protocol
from uuid import uuid4

from backend.identity import namespace_key
from backend.sample_data import build_sample_snapshot
from backend.schemas import Snapshot
from backend import schemas
from backend.domain_validation import merge_source_evidence, validate_record


class SnapshotStore(Protocol):
    namespace: str
    dataset_id: str
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

    namespace = namespace_key()  # Explicit synthetic memory fixture dataset.

    def __init__(self, snapshot: dict | None = None):
        self._lock = RLock()
        self.dataset_id = str(uuid4())
        self.revision = 0
        self.epoch = 0  # #55 data-lifecycle epoch; persists only for this fixture instance.
        self.restore_receipts: dict[str, tuple[str, dict]] = {}
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
            self.revision += 1
            return deepcopy(self._snapshot)

    def mutate(self, operation: Callable[[dict], None]) -> dict:
        with self._lock:
            next_snapshot = deepcopy(self._snapshot)
            operation(next_snapshot)
            if 'reconciliation' in next_snapshot:
                from backend.reconciliation import project_sources
                project_sources(next_snapshot, self.namespace)
            self._snapshot = self._validated(next_snapshot)
            self.revision += 1
            return deepcopy(self._snapshot)
