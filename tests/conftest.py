from pathlib import Path
from urllib.parse import urlsplit

import fastapi.testclient
import pytest
import starlette.testclient
import yaml
from fastapi.testclient import TestClient as _BaseTestClient

BINDING_HEADER = 'X-Moodle-Helper-Bridge-Binding'
# #63: the backend answers only loopback Host names, so the suite never uses "testserver".
LOOPBACK_BASE_URL = 'http://127.0.0.1:8000'
# Routes that required the binding before #62; their tests already send it
# explicitly (or deliberately omit it), so they are never auto-bound.
BOUND_BEFORE_62 = ('/api/ai/', '/api/backups/restore', '/api/local-data/erase', '/api/local-data/erasures/', '/api/reminders/',
                   '/api/material-downloads', '/api/queue/', '/api/scan/', '/api/collection/',
                   '/api/local-syllabus/')


class TestClient(_BaseTestClient):
    """Suite-wide TestClient (#62, #63).

    Defaults to a loopback base URL (Host 127.0.0.1:8000) because the backend
    rejects every other Host with 400.

    Every write now requires the current process binding. Tests written before
    #62 for routes that were unbound then get the live binding attached when
    they send no binding header at all; a test that probes the unbound
    boundary passes ``bind_writes=False`` (or sends its own header value).
    """
    __test__ = False

    def __init__(self, app, *args, bind_writes=True, base_url=LOOPBACK_BASE_URL, **kwargs):
        super().__init__(app, *args, base_url=base_url, **kwargs)
        self.bind_writes = bind_writes

    def request(self, method, url, *args, headers=None, **kwargs):
        if self.bind_writes and method.upper() not in ('GET', 'HEAD', 'OPTIONS'):
            supplied = {key.lower() for key in (headers or {})}
            binding = getattr(getattr(self.app, 'state', None), 'bridge_binding', None)
            path = urlsplit(str(url)).path
            legacy = not path.startswith(BOUND_BEFORE_62) and not (
                path.startswith('/api/candidates/') and isinstance(kwargs.get('json'), dict) and 'localReview' in kwargs['json'])
            if legacy and BINDING_HEADER.lower() not in supplied and binding is not None:
                headers = {**(headers or {}), BINDING_HEADER: binding}
        return super().request(method, url, *args, headers=headers, **kwargs)


# Test modules import TestClient after conftest loads, so they get the subclass.
fastapi.testclient.TestClient = TestClient
starlette.testclient.TestClient = TestClient
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
