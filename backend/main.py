"""ASGI application entry point."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from backend.routers import router
from backend.services import BackendService
from backend.storage import InMemoryStore, SnapshotStore


def create_app(store: SnapshotStore | None = None) -> FastAPI:
    app = FastAPI(title="Moodle Helper", version="0.1.0",
                  description="Local fictional demo API; one process-local dataset, no authentication or live Moodle access.")
    app.state.service = BackendService(InMemoryStore() if store is None else store)

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
