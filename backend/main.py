"""ASGI application entry point."""

import os
import re
from collections.abc import Callable
from uuid import uuid4
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from backend.material_downloads import MaterialDownloadService, TransferConflict, material_download_router
from backend.routers import router, context_router, collection_router, queue_router, scan_router, local_syllabus_router, reminder_router, ai_router, backup_router, erase_router
from backend.ai_gateway import AiGateway, AiFailure, MAX_BODY_BYTES
from backend.reminders import ReminderService, ReminderConflict
from backend.queue import QueueService, QueueConflict, QueueMissing, QueueInvalid
from backend.services import BackendService, SyncUnavailable, SYNC_UNAVAILABLE
from backend.reconciliation import ReconciliationConflict
from backend.storage import SnapshotStore
from backend.database_config import DatabaseConfig
from backend.sqlite_store import SQLiteStore, StorageError
from backend.collection import CollectionService, CollectionRejected
from backend.scan_queue import ScanQueueService
from backend.backup_restore import RestoreService, MAX_BACKUP_BYTES
from backend.local_erase import EraseService
from backend.storage import EpochConflict, expected_epoch


# #63: loopback names only, any or no port. Exact match, so rebinding names such as
# 127.0.0.1.attacker.example, a trailing-dot localhost. or unbracketed ::1 fail.
LOOPBACK_HOST = re.compile(r'(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?')


class LoopbackHostMiddleware:
    """Rejects any request whose single Host header is not loopback with 400, before routing.

    Forwarded headers (X-Forwarded-Host) are ignored; only the Host header counts.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        hosts = [value for name, value in scope.get('headers', []) if name.lower() == b'host']
        host = hosts[0].decode('latin-1').lower() if len(hosts) == 1 else ''
        if LOOPBACK_HOST.fullmatch(host):
            return await self.app(scope, receive, send)
        if scope['type'] == 'websocket':
            return await send({'type': 'websocket.close', 'code': 1008})
        response = JSONResponse(status_code=400, content={'message': 'Invalid Host header. Use 127.0.0.1, localhost or [::1].'})
        await response(scope, receive, send)


def create_app(store: SnapshotStore | None = None, *, collection_provider=None, queue_clock=None, reminder_clock=None, reminder_resolver=None,
               store_factory: Callable[[], SnapshotStore] | None = None, ai_gateway: AiGateway | None = None,
               material_download_capability=None) -> FastAPI:
    # Trusted construction only: no request, query, header or page message selects a provider.
    gateway = ai_gateway or AiGateway()
    if store is not None and store_factory is not None:
        raise ValueError('Provide either store or store_factory, not both.')
    raw_concurrency = os.environ.get('MOODLE_HELPER_QUEUE_CONCURRENCY', '1')
    if raw_concurrency not in ('1', '2', '3', '4'):
        raise ValueError('MOODLE_HELPER_QUEUE_CONCURRENCY must be an integer from 1 to 4.')
    concurrency = int(raw_concurrency)
    def make_queue(selected):
        return QueueService(selected, concurrency, **({'clock':queue_clock} if queue_clock else {}))
    def make_reminders(selected):
        return ReminderService(selected, reminder_clock, **({'resolver': reminder_resolver} if reminder_resolver else {}))
    def make_erase(app, selected):
        from backend.reminders import MemoryLedger
        rows = app.state.material_downloads.rows
        ledger = app.state.reminders.ledger
        return EraseService(selected, reminder_clock, None if hasattr(rows, 'connection') else rows,
                            ledger if isinstance(ledger, MemoryLedger) else None, on_commit=app.state.collection.invalidate)
    @asynccontextmanager
    async def lifespan(app):
        selected = store
        if selected is None and store_factory is not None:
            selected = store_factory()
        if selected is None:
            configuration = DatabaseConfig.from_environment(os.environ)
            selected = SQLiteStore(configuration.url, configuration.namespace)
        app.state.service = BackendService(selected)
        app.state.queue = make_queue(selected)
        app.state.bridge_binding = uuid4().hex
        app.state.collection = CollectionService(selected, app.state.bridge_binding, collection_provider)
        app.state.reminders = make_reminders(selected)
        app.state.material_downloads = MaterialDownloadService(selected, material_download_capability)
        app.state.restore = RestoreService(selected, reminder_clock, reminder_resolver,
                                           None if hasattr(app.state.material_downloads.rows, 'connection') else app.state.material_downloads.rows)
        app.state.erase = make_erase(app, selected)
        app.state.scan = ScanQueueService(selected, app.state.collection, concurrency=concurrency, **({'clock':queue_clock} if queue_clock else {}))
        app.state.ai_gateway = gateway
        try:
            yield
        finally:
            if store is None and hasattr(selected, 'close'):
                selected.close()

    app = FastAPI(title="Moodle Helper", version="0.1.0",
                  description="Local fictional demo API; one process-local dataset, no authentication or live Moodle access.", lifespan=lifespan)
    app.state.ai_gateway = gateway
    if store is not None:
        app.state.service = BackendService(store)
        app.state.queue = make_queue(store)
        app.state.bridge_binding = uuid4().hex
        app.state.collection = CollectionService(store, app.state.bridge_binding, collection_provider)
        app.state.reminders = make_reminders(store)
        app.state.material_downloads = MaterialDownloadService(store, material_download_capability)
        app.state.restore = RestoreService(store, reminder_clock, reminder_resolver,
                                           None if hasattr(app.state.material_downloads.rows, 'connection') else app.state.material_downloads.rows)
        app.state.erase = make_erase(app, store)
        app.state.scan = ScanQueueService(store, app.state.collection, concurrency=concurrency, **({'clock':queue_clock} if queue_clock else {}))

    @app.middleware("http")
    async def bridge_precondition(request: Request, call_next):
        # Runs before body parsing and service work, including malformed writes.
        binding = request.headers.get("X-Moodle-Helper-Bridge-Binding")
        collection_write = request.url.path in ['/api/collection/visits', '/api/collection/refresh']
        queue_write = request.url.path.startswith(('/api/queue/', '/api/scan/', '/api/reminders/', '/api/material-downloads')) and request.method not in ['GET','HEAD','OPTIONS']
        local_syllabus_write = request.url.path == '/api/local-syllabus/route' and request.method == 'POST'
        local_review_write = False
        if request.method == 'POST' and request.url.path.startswith('/api/candidates/') and request.url.path.endswith('/review'):
            candidate_id = request.url.path[len('/api/candidates/'):-len('/review')]
            try:
                local_review_write = any(item['id'] == candidate_id and item.get('localEvidence') for item in app.state.service.store.read()['candidates'])
            except StorageError as error:
                return JSONResponse(status_code=503, content={'message': str(error)})
        if request.url.path.startswith('/api/ai/') and request.method not in ['GET','HEAD','OPTIONS']:
            # Binding, then a hard 16 KiB body bound, before parsing or provider work.
            if binding != getattr(app.state, 'bridge_binding', None):
                return JSONResponse(status_code=409, content={'message':'Backend context changed. Reconnect.'})
            declared = request.headers.get('content-length')
            if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
                return JSONResponse(status_code=413, content=AiFailure('payload_too_large').body())
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    return JSONResponse(status_code=413, content=AiFailure('payload_too_large').body())
                chunks.append(chunk)
            # Starlette replays the cached body to the handler and still reports disconnects.
            request._body = b''.join(chunks)
            return await call_next(request)
        if request.url.path == '/api/backups/restore' and request.method == 'POST':
            # Binding and the fixed 20 MiB bound before any parse or service work (#55).
            if binding != getattr(app.state, 'bridge_binding', None):
                return JSONResponse(status_code=409, content={'message': 'Backend context changed. Reconnect and refresh the restore preview.'})
            too_large = JSONResponse(status_code=413, content={'message': 'Backup exceeds the 20 MiB restore limit. Nothing was changed.'})
            declared = request.headers.get('content-length')
            if declared is not None and (not declared.isdigit() or int(declared) > MAX_BACKUP_BYTES + 4096):
                return too_large
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BACKUP_BYTES + 4096:
                    return too_large
                chunks.append(chunk)
            body = b''.join(chunks)
            import json
            try:
                json.loads(body.decode('utf-8'))
            except UnicodeDecodeError:
                return JSONResponse(status_code=422, content={'message': 'Restore request is not valid UTF-8. Nothing was changed.'})
            except RecursionError:
                return JSONResponse(status_code=422, content={'message': 'Backup is too deeply nested to restore safely. Nothing was changed.'})
            except ValueError:
                return JSONResponse(status_code=422, content={'message': 'Restore request is not valid JSON. Nothing was changed.'})
            request._body = body
            return await call_next(request)
        erase_write = request.url.path == '/api/local-data/erase' or (request.url.path.startswith('/api/local-data/erasures/') and request.url.path.endswith('/ack'))
        if erase_write and request.method == 'POST':
            # #56: binding and a 1 MiB control-request bound before parsing.
            if binding != getattr(app.state, 'bridge_binding', None):
                return JSONResponse(status_code=409, content={'message': 'Backend context changed. Reconnect and confirm again; nothing was deleted.'})
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 1024 * 1024:
                    return JSONResponse(status_code=413, content={'message': 'Request exceeds the 1 MiB limit. Nothing was deleted.'})
                chunks.append(chunk)
            request._body = b''.join(chunks)
            return await call_next(request)
        if (collection_write or queue_write or local_syllabus_write or local_review_write) and binding != getattr(app.state, 'bridge_binding', None):
            return JSONResponse(status_code=409, content={'message':'Collection context changed. Reconnect.'})
        if (request.url.path.startswith('/api/') and request.method not in ['GET', 'HEAD', 'OPTIONS']
                and binding != getattr(app.state, 'bridge_binding', None)):
            # #62: every write needs the current binding, before body parsing or store work, so
            # cross-site CORS-simple posts (no custom header possible) can never change data.
            return JSONResponse(status_code=409, content={'message': 'Backend context changed. Reconnect.'})
        if request.url.path.startswith(('/api/collection', '/api/queue/', '/api/scan/', '/api/reminders/', '/api/material-downloads')) or local_syllabus_write or local_review_write:
            chunks = []
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 1024 * 1024:
                    return JSONResponse(status_code=422, content={'message':'Request exceeds the size limit.'})
                chunks.append(chunk)
            body = b''.join(chunks)
            if local_review_write:
                import json
                try:
                    incoming = json.loads(body)
                except (ValueError, UnicodeError):
                    return JSONResponse(status_code=422, content={'message': 'Invalid local review JSON.'})
                if request.query_params or not isinstance(incoming, dict) or not isinstance(incoming.get('localReview'), dict) or incoming['localReview'].get('datasetId') != app.state.service.store.dataset_id:
                    return JSONResponse(status_code=409, content={'message': 'Local review context changed. Reconnect.'})
            request._body = body
            sent = False
            async def replay():
                nonlocal sent
                if sent: return {'type':'http.request','body':b'','more_body':False}
                sent = True
                return {'type':'http.request','body':body,'more_body':False}
            request._receive = replay
        elif request.url.path.startswith('/api/') and request.url.path != '/api/sync' and request.method not in ['GET','HEAD','OPTIONS']:
            app.state.collection.invalidate()
        if (request.url.path.startswith("/api/") and request.url.path != "/api/bridge-context"
                and binding is not None and binding != getattr(app.state, "bridge_binding", None)):
            return JSONResponse(status_code=409, content={"message": "Backend context changed. Reconnect."})
        return await call_next(request)

    @app.exception_handler(AiFailure)
    async def ai_failure(request: Request, error: AiFailure):
        headers = {'Retry-After': str(error.retry_after)} if error.retry_after else None
        return JSONResponse(status_code=error.status, content=error.body(), headers=headers)

    @app.exception_handler(StorageError)
    async def storage_error(request: Request, error: StorageError):
        return JSONResponse(status_code=503, content={"message": str(error)})

    @app.exception_handler(ReconciliationConflict)
    async def reconciliation_error(request: Request, error: ReconciliationConflict):
        return JSONResponse(status_code=409, content={'message': str(error)})

    @app.exception_handler(SyncUnavailable)
    async def sync_unavailable(request: Request, error: SyncUnavailable):
        return JSONResponse(status_code=503, content={'message': SYNC_UNAVAILABLE})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        if request.url.path.startswith('/api/ai/'):
            return JSONResponse(status_code=422, content=AiFailure('invalid_request').body())
        if request.url.path.startswith(('/api/collection', '/api/queue/', '/api/scan/', '/api/reminders/')):
            return JSONResponse(status_code=422, content={'message':'Invalid request.'})
        errors = [f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}" for item in error.errors()]
        return JSONResponse(status_code=422, content={"message": "Invalid request: " + "; ".join(errors)})

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        return JSONResponse(status_code=error.status_code, content={"message": str(error.detail)}, headers=error.headers)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        return JSONResponse(status_code=500, content={"message": "Internal server error."})

    @app.exception_handler(CollectionRejected)
    async def collection_error(request: Request, error: CollectionRejected):
        return JSONResponse(status_code=409, content={'message':'Collection context or evidence is invalid. Reconnect.'})

    @app.exception_handler(QueueConflict)
    async def queue_conflict(request: Request, error: QueueConflict):
        return JSONResponse(status_code=409, content={'message':'Queue key or claim conflicts with current state.'})

    @app.exception_handler(QueueMissing)
    async def queue_missing(request: Request, error: QueueMissing):
        return JSONResponse(status_code=404, content={'message':'Queue run not found.'})

    @app.exception_handler(QueueInvalid)
    async def queue_invalid(request: Request, error: QueueInvalid):
        return JSONResponse(status_code=422, content={'message':'Invalid queue request.'})

    @app.exception_handler(TransferConflict)
    async def material_transfer_conflict(request: Request, error: TransferConflict):
        return JSONResponse(status_code=409, content={'message': str(error)})

    @app.exception_handler(EpochConflict)
    async def epoch_conflict(_request, error):
        return JSONResponse(status_code=409, content={'message': str(error)})

    @app.middleware("http")
    async def data_epoch_precondition(request: Request, call_next):
        # Outermost: sets the per-request epoch precondition checked inside write transactions (#56).
        raw = request.headers.get('X-Moodle-Helper-Data-Epoch')
        if raw is None:
            return await call_next(request)
        if not raw.isdigit() or len(raw) > 18:
            return JSONResponse(status_code=422, content={'message': 'Invalid data epoch header.'})
        token = expected_epoch.set(int(raw))
        try:
            return await call_next(request)
        finally:
            expected_epoch.reset(token)

    @app.exception_handler(ReminderConflict)
    async def reminder_conflict(request: Request, error: ReminderConflict):
        return JSONResponse(status_code=409, content={'message': str(error)})

    app.include_router(reminder_router)
    app.include_router(backup_router)
    app.include_router(erase_router)
    app.include_router(material_download_router)
    app.include_router(queue_router)
    app.include_router(scan_router)
    app.include_router(router)
    app.include_router(context_router)
    app.include_router(collection_router)
    app.include_router(local_syllabus_router)
    app.include_router(ai_router)
    # Added last, so it is outermost: runs before every other middleware and routing.
    app.add_middleware(LoopbackHostMiddleware)
    return app


app = create_app()

