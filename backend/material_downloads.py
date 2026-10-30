"""Explicit single-file material transfer metadata (#41).

The backend never fetches Moodle bytes. It resolves a stable material ID to a
validated credential-free SDU pluginfile destination, registers one opaque
transfer per dataset+material, and records honest progress/terminal outcomes
reported by the extension's packaged transfer page. Ordinary runtime has no
verified SDU source/session capability, so registration fails closed unless a
capability is injected in-process (synthetic fixtures only).
"""

import json
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from threading import RLock
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import Field

from backend.schemas import Integer, ProposedHttpError, WireModel

MAX_BYTES = 20 * 1024 * 1024
TIMEOUT_MS = 60_000
OpaqueId = Annotated[str, Field(pattern=r'^[A-Za-z0-9-]{1,128}$')]
MaterialId = Annotated[str, Field(min_length=1, max_length=256)]
State = Literal['queued', 'validating', 'saving', 'complete', 'failed', 'cancelled', 'interrupted']
Reason = Literal['sign_in_required', 'forbidden', 'not_found', 'network', 'unsupported_type', 'too_large',
                 'timeout', 'cancelled_by_user', 'page_closed', 'download_interrupted', 'outcome_unknown']
Unsupported = Literal['material_not_found', 'not_a_file', 'unsupported_type', 'unsafe_destination', 'source_unavailable']
ACTIVE = ('queued', 'validating', 'saving')
TERMINAL = ('complete', 'failed', 'cancelled', 'interrupted')
NEXT = {'queued': {'validating', 'failed', 'cancelled', 'interrupted'},
        'validating': {'validating', 'saving', 'failed', 'cancelled', 'interrupted'},
        'saving': {'saving', 'complete', 'failed', 'cancelled', 'interrupted'}}
PLUGINFILE = re.compile(r'^https://moodle\.sdu\.edu\.kz/pluginfile\.php/[1-9][0-9]*/mod_resource/content/[1-9][0-9]*/'
                        r'(?:[A-Za-z0-9._~!$&\'()*+,;=:@-]|%[0-9A-F]{2})+(?:\?forcedownload=1)?$')
MESSAGES = {
    'material_not_found': 'This material is no longer in your local index. Refresh materials and try again.',
    'not_a_file': 'Only a single file can be downloaded. Folders and links open in Moodle instead.',
    'unsupported_type': 'Only PDF files can be downloaded for now. Open this resource in Moodle instead.',
    'unsafe_destination': 'This file has no verified Moodle download address. Open it in Moodle instead.',
    'source_unavailable': 'Downloads need a verified signed-in Moodle session in the Chrome extension, which is not available yet. Open the file in Moodle instead.',
}


class MaterialDownloadStart(WireModel):
    datasetId: OpaqueId
    materialId: MaterialId
    idempotencyKey: OpaqueId


class MaterialTransfer(WireModel):
    transferId: OpaqueId
    generation: Integer = Field(ge=0)
    materialId: MaterialId
    state: State
    reason: Reason = None
    downloadId: Integer = Field(default=None, ge=0)
    bytesReceived: Integer = Field(default=None, ge=0)
    totalBytes: Integer = Field(default=None, ge=0)
    cancelRequested: bool
    createdAt: str
    updatedAt: str
    completedAt: str = None


class MaterialDownloadStartResult(WireModel):
    supported: bool
    message: str
    reason: Unsupported = None
    transfer: MaterialTransfer = None


class MaterialDownloadList(WireModel):
    transfers: list[MaterialTransfer] = Field(max_length=1000)


class MaterialTransferDescriptor(WireModel):
    transferId: OpaqueId
    generation: Integer = Field(ge=0)
    attemptId: OpaqueId
    materialId: MaterialId
    url: str
    format: Literal['pdf']
    suggestedName: str = Field(default=None, max_length=200)
    maxBytes: Integer = Field(ge=1)
    timeoutMs: Integer = Field(ge=1)


class MaterialTransferStatus(WireModel):
    generation: Integer = Field(ge=0)
    attemptId: OpaqueId
    state: State
    reason: Reason = None
    downloadId: Integer = Field(default=None, ge=0)
    bytesReceived: Integer = Field(default=None, ge=0, le=MAX_BYTES)
    totalBytes: Integer = Field(default=None, ge=0)


class TransferConflict(RuntimeError):
    pass


def resolve(snapshot: dict, material_id: str) -> tuple[dict | None, str | None]:
    """Exact descriptor from current stored facts, or a fixed unsupported reason."""
    record = next((r for r in (snapshot.get('collection') or {}).get('records', [])
                   if r.get('kind') == 'material' and r.get('id') == material_id), None)
    if record is not None:
        o = record['observations'][-1]
        if o['kind'] != 'file' or o['sourceModuleType'] != 'resource':
            return None, 'not_a_file'
        file_type = o['fileType'].get('value') if o['fileType']['kind'] == 'known' else None
        mime = o['mimeType'].get('value') if o['mimeType']['kind'] == 'known' else None
        if file_type != 'pdf' or mime not in (None, 'application/pdf'):
            return None, 'unsupported_type'
        url = o.get('destinationUrl')
        title = o['title'].get('value') if o['title']['kind'] == 'known' else None
    else:
        legacy = next((m for m in snapshot['materials'] if m['id'] == material_id), None)
        if legacy is None:
            return None, 'material_not_found'
        if legacy['fileType'] in ('link', 'video'):
            return None, 'not_a_file'
        if legacy['fileType'] != 'pdf':
            return None, 'unsupported_type'
        url, title = legacy['url'], legacy['title']
    if not url or not PLUGINFILE.match(url):
        return None, 'unsafe_destination'
    descriptor = {'url': url, 'format': 'pdf'}
    if isinstance(title, str) and title.strip():
        descriptor['suggestedName'] = title.strip()[:200]
    return descriptor, None


class _MemoryRows:
    def __init__(self):
        self.lock, self.rows = RLock(), {}

    @contextmanager
    def transaction(self, store):
        with self.lock:
            saved = json.dumps(self.rows)
            try:
                yield self
            except BaseException:
                self.rows = json.loads(saved)
                raise

    def all(self, namespace):
        return [r for r in self.rows.values() if r['namespace'] == namespace]

    def put(self, row):
        self.rows[row['namespace'] + '/' + row['transferId']] = json.loads(json.dumps(row))


class _SqlRows:
    def __init__(self):
        self.connection = None

    @contextmanager
    def transaction(self, store):
        with store._transaction() as connection:
            self.connection = connection
            try:
                yield self
            finally:
                self.connection = None

    def all(self, namespace):
        from sqlalchemy import text
        return [json.loads(v) for v in self.connection.execute(
            text('SELECT record FROM material_transfers WHERE namespace=:n ORDER BY created, transfer_id'), {'n': namespace}).scalars()]

    def put(self, row):
        from sqlalchemy import text
        self.connection.execute(text(
            'INSERT INTO material_transfers(namespace,transfer_id,material_id,created,record) VALUES(:n,:t,:m,:c,:r) '
            'ON CONFLICT(namespace,transfer_id) DO UPDATE SET record=excluded.record'),
            {'n': row['namespace'], 't': row['transferId'], 'm': row['materialId'], 'c': row['createdAt'], 'r': json.dumps(row)})


class MaterialDownloadService:
    def __init__(self, store, capability=None, clock=None, uuid=None):
        from backend.sqlite_store import SQLiteStore
        self.store, self.capability = store, capability
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.uuid = uuid or (lambda: uuid4().hex)
        self.rows = _SqlRows() if isinstance(store, SQLiteStore) else _MemoryRows()

    def _now(self):
        return self.clock().astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    @staticmethod
    def public(row: dict) -> dict:
        return {k: v for k, v in row.items() if k in MaterialTransfer.model_fields and v is not None}

    def _mine(self, rows):
        return [r for r in rows.all(self.store.namespace) if r['datasetId'] == self.store.dataset_id]

    def _find(self, rows, transfer_id):
        row = next((r for r in self._mine(rows) if r['transferId'] == transfer_id), None)
        if row is None:
            raise HTTPException(status_code=404, detail='Transfer not found.')
        return row

    def start(self, body: dict) -> dict:
        if body['datasetId'] != self.store.dataset_id:
            raise TransferConflict('Local data changed. Reload and try again.')
        snapshot = self.store.read()
        descriptor, reason = resolve(snapshot, body['materialId'])
        if reason is None and not self.capability:
            reason = 'source_unavailable'  # Fail closed: no verified SDU session capability.
        if reason:
            return {'supported': False, 'reason': reason, 'message': MESSAGES[reason]}
        with self.rows.transaction(self.store) as rows:
            mine = self._mine(rows)
            same = next((r for r in mine if r['idempotencyKey'] == body['idempotencyKey']), None)
            if same is not None and same['materialId'] != body['materialId']:
                raise TransferConflict('Idempotency key was used for another material.')
            active = same or next((r for r in mine if r['materialId'] == body['materialId'] and r['state'] in ACTIVE), None)
            if active is not None:  # Repeated click returns the same transfer, never a duplicate.
                return {'supported': True, 'message': 'This download is already in progress.', 'transfer': self.public(active)}
            t = self._now()
            row = {'namespace': self.store.namespace, 'datasetId': self.store.dataset_id,
                   'idempotencyKey': body['idempotencyKey'], 'transferId': self.uuid(), 'attemptId': self.uuid(),
                   'generation': 0, 'materialId': body['materialId'], 'state': 'queued', 'cancelRequested': False,
                   'descriptorIssued': False, 'createdAt': t, 'updatedAt': t, **{'descriptor': descriptor}}
            rows.put(row)
            return {'supported': True, 'message': 'Download queued.', 'transfer': self.public(row)}

    def read(self, transfer_id: str) -> dict:
        with self.rows.transaction(self.store) as rows:
            return self.public(self._find(rows, transfer_id))

    def list(self) -> dict:
        with self.rows.transaction(self.store) as rows:
            latest = {}
            for r in self._mine(rows):
                latest[r['materialId']] = r  # created order: last attempt wins
            return {'transfers': [self.public(r) for r in list(latest.values())[-1000:]]}

    def descriptor(self, transfer_id: str) -> dict:
        """One-use, worker/page only. Rereads current material facts, never a stale URL."""
        with self.rows.transaction(self.store) as rows:
            row = self._find(rows, transfer_id)
            if row['state'] != 'queued' or row['descriptorIssued'] or row['cancelRequested']:
                raise TransferConflict('Transfer is no longer waiting to start.')
            descriptor, reason = resolve(self.store.read(), row['materialId'])
            if reason or not self.capability or descriptor['url'] != row['descriptor']['url']:
                row.update(state='failed', reason='outcome_unknown' if not reason else 'unsupported_type',
                           updatedAt=self._now(), generation=row['generation'] + 1)
                rows.put(row)
                changed = True
            else:
                changed = False
                row.update(descriptorIssued=True)
                rows.put(row)
        if changed:  # Committed failure first; the page must not fetch a changed context.
            raise TransferConflict('Material context changed. Retry the download.')
        return {'transferId': row['transferId'], 'generation': row['generation'], 'attemptId': row['attemptId'],
                'materialId': row['materialId'], **descriptor, 'maxBytes': MAX_BYTES, 'timeoutMs': TIMEOUT_MS}

    def cancel(self, transfer_id: str) -> dict:
        with self.rows.transaction(self.store) as rows:
            row = self._find(rows, transfer_id)
            if row['state'] in TERMINAL:
                return self.public(row)
            row.update(cancelRequested=True, updatedAt=self._now(), generation=row['generation'] + 1)
            if row['state'] == 'queued' and not row['descriptorIssued']:
                row.update(state='cancelled', reason='cancelled_by_user')
            rows.put(row)
            return self.public(row)

    def status(self, transfer_id: str, body: dict) -> dict:
        complete_at = None
        with self.rows.transaction(self.store) as rows:
            row = self._find(rows, transfer_id)
            if body['attemptId'] != row['attemptId']:
                raise TransferConflict('Transfer attempt does not match.')
            if row['state'] in TERMINAL:
                if body['state'] == row['state'] and body.get('downloadId') == row.get('downloadId'):
                    return self.public(row)  # Idempotent terminal replay.
                raise TransferConflict('Transfer already finished.')
            if body['generation'] != row['generation'] and not (row['cancelRequested'] and body['generation'] < row['generation']):
                raise TransferConflict('Transfer generation is stale.')
            state = body['state']
            if state not in NEXT[row['state']]:
                raise TransferConflict('Transfer state transition is not allowed.')
            if row.get('downloadId') is not None and body.get('downloadId') not in (None, row['downloadId']):
                raise TransferConflict('Chrome download identifier cannot change.')
            if state == 'complete' and (body.get('downloadId') or row.get('downloadId')) is None:
                raise TransferConflict('Completion requires the matching Chrome download identifier.')
            if state in ('failed', 'cancelled', 'interrupted') and not body.get('reason'):
                raise TransferConflict('A terminal failure needs a reason.')
            t = self._now()
            row.update(state=state, updatedAt=t, generation=row['generation'] + 1)
            for key in ('reason', 'downloadId', 'bytesReceived', 'totalBytes'):
                if body.get(key) is not None:
                    row[key] = body[key]
            if state == 'complete':
                row.update(completedAt=t, reason=None)
                complete_at = t
            rows.put(row)
            result = self.public(row)
        if complete_at:
            material_id = row['materialId']
            def apply(snapshot):
                for m in snapshot['materials']:
                    if m['id'] == material_id:
                        m['downloadedAt'] = complete_at  # Historical record only, never availability.
            self.store.mutate(apply)
        return result


def downloads(request: Request) -> MaterialDownloadService:
    return request.app.state.material_downloads


def required_binding(binding: Annotated[str, Header(alias='X-Moodle-Helper-Bridge-Binding', description='Required current process binding. Absent or stale returns 409 before processing.')]):
    pass


material_download_router = APIRouter(prefix='/api/material-downloads', tags=['Materials'], dependencies=[Depends(required_binding)],
                                      responses={'default': {'model': ProposedHttpError}, 409: {'model': ProposedHttpError}, 422: {'model': ProposedHttpError}})
TransferId = Annotated[str, __import__('fastapi').Path(pattern=r'^[A-Za-z0-9-]{1,128}$')]


@material_download_router.post('', response_model=MaterialDownloadStartResult, response_model_exclude_none=True, operation_id='startMaterialDownload')
def start_material_download(body: MaterialDownloadStart, request: Request):
    return downloads(request).start(body.model_dump(exclude_none=True))


@material_download_router.get('', response_model=MaterialDownloadList, response_model_exclude_none=True, operation_id='listMaterialDownloads')
def list_material_downloads(request: Request):
    return downloads(request).list()


@material_download_router.get('/{transferId}', response_model=MaterialTransfer, response_model_exclude_none=True, operation_id='materialDownload')
def read_material_download(transferId: TransferId, request: Request):
    return downloads(request).read(transferId)


@material_download_router.post('/{transferId}/cancel', response_model=MaterialTransfer, response_model_exclude_none=True, operation_id='cancelMaterialDownload')
def cancel_material_download(transferId: TransferId, request: Request):
    return downloads(request).cancel(transferId)


@material_download_router.post('/{transferId}/descriptor', response_model=MaterialTransferDescriptor, response_model_exclude_none=True, operation_id='materialDownloadDescriptor')
def material_download_descriptor(transferId: TransferId, request: Request):
    return downloads(request).descriptor(transferId)


@material_download_router.post('/{transferId}/status', response_model=MaterialTransfer, response_model_exclude_none=True, operation_id='reportMaterialDownload')
def report_material_download(transferId: TransferId, body: MaterialTransferStatus, request: Request):
    return downloads(request).status(transferId, body.model_dump(exclude_none=True))
