from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from backend.main import create_app


@pytest.fixture
def client():
    with TestClient(create_app()) as client:
        yield client


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
