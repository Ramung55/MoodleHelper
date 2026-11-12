from fastapi.testclient import TestClient

from backend.main import create_app
from backend.storage import InMemoryStore


def test_health_checks_storage_and_reports_release(monkeypatch):
    monkeypatch.setenv("MOODLE_HELPER_RELEASE", "test-release")
    store = InMemoryStore()
    with TestClient(create_app(store), base_url="http://localhost") as client:
        assert client.get("/health").json() == {"status": "ok", "release": "test-release"}
        def fail():
            raise RuntimeError("database unavailable")
        monkeypatch.setattr(store, "read", fail)
        response = client.get("/health")
        assert response.status_code == 503
        assert response.json() == {"status": "unhealthy"}
