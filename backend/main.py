"""ASGI application entry point."""

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from backend.routers import router
from backend.services import BackendService
from backend.storage import SnapshotStore
from backend.database_config import DatabaseConfig
from backend.sqlite_store import SQLiteStore, StorageError


def create_app(store: SnapshotStore | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        selected = store
        if selected is None:
            configuration = DatabaseConfig.from_environment(os.environ)
            selected = SQLiteStore(configuration.url, configuration.namespace)
        app.state.service = BackendService(selected)
        try:
            yield
        finally:
            if store is None:
                selected.close()

    app = FastAPI(title="Moodle Helper", version="0.1.0",
                  description="Local fictional demo API; one process-local dataset, no authentication or live Moodle access.", lifespan=lifespan)
    if store is not None:
        app.state.service = BackendService(store)

    @app.exception_handler(StorageError)
    async def storage_error(request: Request, error: StorageError):
        return JSONResponse(status_code=503, content={"message": str(error)})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        errors = [f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}" for item in error.errors()]
        return JSONResponse(status_code=422, content={"message": "Invalid request: " + "; ".join(errors)})

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        return JSONResponse(status_code=error.status_code, content={"message": str(error.detail)}, headers=error.headers)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        return JSONResponse(status_code=500, content={"message": "Internal server error."})

    app.include_router(router)
    return app


app = create_app()
