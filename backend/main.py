"""ASGI application entry point."""

from fastapi import FastAPI


def create_app() -> FastAPI:
    return FastAPI(title="Moodle Helper", version="0.1.0")


app = create_app()
