from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from backend.main import create_app
from backend.storage import InMemoryStore
from backend.sqlite_store import SQLiteStore
from sqlalchemy import URL


@pytest.fixture(params=["memory", "sqlite"])
def client(request, tmp_path):
    store = (InMemoryStore() if request.param == "memory" else
             SQLiteStore(URL.create("sqlite", database=str(tmp_path / "api.sqlite3"))))
    try:
        with TestClient(create_app(store)) as client:
            yield client
    finally:
        if isinstance(store, SQLiteStore):
            store.close()


@pytest.fixture(scope="session")
def contract():
    return yaml.safe_load((Path(__file__).parents[1] / "openapi.yaml").read_text(encoding="utf-8"))


@pytest.fixture
def contract_validator(contract):
    def validator(schema, data):
        # Keep source-local JSON pointers resolvable in the selected subschema.
        wrapped = {**schema, "components": contract["components"]}
        Draft202012Validator(wrapped).validate(data)
    return validator
