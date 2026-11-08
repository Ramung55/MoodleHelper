"""Explicit ephemeral ASGI application; see backend/README.md for limitations."""

from fastapi import FastAPI

from backend.main import create_app as create_backend_app
from backend.storage import InMemoryStore


def create_app() -> FastAPI:
    """Create an app with fresh fictional data for each application lifespan."""
    return create_backend_app(store_factory=InMemoryStore)


app = create_app()
