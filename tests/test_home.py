from fastapi.testclient import TestClient

from backend.main import create_app
from backend.storage import InMemoryStore


def test_application_starts_and_serves_documentation():
    with TestClient(create_app(InMemoryStore())) as client:
        assert client.get("/docs").status_code == 200
        response = client.get("/openapi.json")
        assert response.status_code == 200
        assert response.json()["info"]["title"] == "Moodle Helper"
