from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

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
    registry = Registry().with_resource("urn:moodle:contract", Resource.from_contents(contract, default_specification=DRAFT202012))

    def validator(schema, data):
        wrapped = {"$id": "urn:moodle:contract", **schema}
        Draft202012Validator(wrapped, registry=registry).validate(data)
    return validator
