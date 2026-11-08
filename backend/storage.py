"""Replaceable Snapshot boundary, source upserts and explicit memory fixture store."""

from collections.abc import Callable
from contextvars import ContextVar
from copy import deepcopy
from threading import RLock
from typing import Protocol
from uuid import uuid4

from backend.identity import namespace_key
from backend.sample_data import build_sample_snapshot
from backend.schemas import Snapshot
from backend import schemas
from backend.domain_validation import merge_source_evidence, validate_record


# #56 data-epoch precondition: set per request from X-Moodle-Helper-Data-Epoch
# (and inherited by tasks spawned from it). Checked INSIDE each write
# transaction, so an old accepted job cannot commit after erase/restore.
expected_epoch: ContextVar[int | None] = ContextVar('expected_epoch', default=None)


class EpochConflict(RuntimeError):
    """The local data lifecycle epoch changed (erase or restore) since the caller loaded."""


def check_epoch(current: int) -> None:
    wanted = expected_epoch.get()
    if wanted is not None and wanted != current:
        raise EpochConflict('Local data was erased or restored since this page loaded. Reload before saving; nothing was changed.')


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
        self.erase_receipts: dict[str, dict] = {}  # #56 nonstudent erase receipts
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
            check_epoch(self.epoch)
            self._snapshot = next_snapshot
            self.revision += 1
            return deepcopy(self._snapshot)

    def mutate(self, operation: Callable[[dict], None]) -> dict:
        with self._lock:
            check_epoch(self.epoch)
            next_snapshot = deepcopy(self._snapshot)
            operation(next_snapshot)
            if 'reconciliation' in next_snapshot:
                from backend.reconciliation import project_sources
                project_sources(next_snapshot, self.namespace)
            self._snapshot = self._validated(next_snapshot)
            self.revision += 1
            return deepcopy(self._snapshot)
