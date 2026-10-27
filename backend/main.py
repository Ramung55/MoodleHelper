"""ASGI application entry point."""

import os
from uuid import uuid4
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from backend.routers import router, context_router, collection_router, queue_router, scan_router
from backend.queue import QueueService, QueueConflict, QueueMissing, QueueInvalid
from backend.services import BackendService, SyncUnavailable, SYNC_UNAVAILABLE
from backend.storage import SnapshotStore
from backend.database_config import DatabaseConfig
from backend.sqlite_store import SQLiteStore, StorageError
from backend.collection import CollectionService, CollectionRejected
from backend.scan_queue import ScanQueueService


def create_app(store: SnapshotStore | None = None, *, collection_provider=None, queue_clock=None) -> FastAPI:
    raw_concurrency = os.environ.get('MOODLE_HELPER_QUEUE_CONCURRENCY', '1')
    if raw_concurrency not in ('1', '2', '3', '4'):
        raise ValueError('MOODLE_HELPER_QUEUE_CONCURRENCY must be an integer from 1 to 4.')
    concurrency = int(raw_concurrency)
    def make_queue(selected):
        return QueueService(selected, concurrency, **({'clock':queue_clock} if queue_clock else {}))
    @asynccontextmanager
    async def lifespan(app):
        selected = store
        if selected is None:
            configuration = DatabaseConfig.from_environment(os.environ)
            selected = SQLiteStore(configuration.url, configuration.namespace)
        app.state.service = BackendService(selected)
        app.state.queue = make_queue(selected)
        app.state.bridge_binding = uuid4().hex
        app.state.collection = CollectionService(selected, app.state.bridge_binding, collection_provider)
        app.state.scan = ScanQueueService(selected, app.state.collection, concurrency=concurrency, **({'clock':queue_clock} if queue_clock else {}))
        try:
            yield
        finally:
            if store is None:
                selected.close()

    app = FastAPI(title="Moodle Helper", version="0.1.0",
                  description="Local fictional demo API; one process-local dataset, no authentication or live Moodle access.", lifespan=lifespan)
    if store is not None:
        app.state.service = BackendService(store)
        app.state.queue = make_queue(store)
        app.state.bridge_binding = uuid4().hex
        app.state.collection = CollectionService(store, app.state.bridge_binding, collection_provider)
        app.state.scan = ScanQueueService(store, app.state.collection, concurrency=concurrency, **({'clock':queue_clock} if queue_clock else {}))

    @app.middleware("http")
    async def bridge_precondition(request: Request, call_next):
        # Runs before body parsing and service work, including malformed writes.
        binding = request.headers.get("X-Moodle-Helper-Bridge-Binding")
        collection_write = request.url.path in ['/api/collection/visits', '/api/collection/refresh']
        queue_write = request.url.path.startswith(('/api/queue/', '/api/scan/')) and request.method not in ['GET','HEAD','OPTIONS']
        if (collection_write or queue_write) and binding != getattr(app.state, 'bridge_binding', None):
            return JSONResponse(status_code=409, content={'message':'Collection context changed. Reconnect.'})
        if request.url.path.startswith(('/api/collection', '/api/queue/', '/api/scan/')):
            chunks = []
            size = 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 1024 * 1024:
                    return JSONResponse(status_code=422, content={'message':'Request exceeds the size limit.'})
                chunks.append(chunk)
            body = b''.join(chunks)
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

    @app.exception_handler(StorageError)
    async def storage_error(request: Request, error: StorageError):
        return JSONResponse(status_code=503, content={"message": str(error)})

    @app.exception_handler(SyncUnavailable)
    async def sync_unavailable(request: Request, error: SyncUnavailable):
        return JSONResponse(status_code=503, content={'message': SYNC_UNAVAILABLE})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        if request.url.path.startswith(('/api/collection', '/api/queue/', '/api/scan/')):
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

    app.include_router(queue_router)
    app.include_router(scan_router)
    app.include_router(router)
    app.include_router(context_router)
    app.include_router(collection_router)
    return app


app = create_app()

