"""Source contract cases independent of the not-yet-enabled live transport."""
from pathlib import Path

import jsonschema
import yaml


def test_scan_contract_closed_pages_and_outcomes():
    document = yaml.safe_load(Path('openapi.yaml').read_text(encoding='utf-8'))
    schemas = document['components']['schemas']
    validator = jsonschema.Draft202012Validator(
        {'$ref': '#/components/schemas/ScanPageInput', 'components': {'schemas': schemas}},
        format_checker=jsonschema.FormatChecker(),
    )
    undiscovered = {'pageType': 'quiz', 'scope': 'unknown', 'outcome': 'undiscovered',
                    'coverage': 'none', 'reasons': ['undiscovered']}
    assert validator.is_valid(undiscovered)
    assert not validator.is_valid({**undiscovered, 'observedAt': '2026-10-27T00:00:00Z'})
    assert not validator.is_valid({**undiscovered, 'reasons': []})
    assert not validator.is_valid({**undiscovered, 'unexpected': True})
    assert not validator.is_valid({**undiscovered, 'outcome': 'forbidden'})
    checked = {**undiscovered, 'observedAt': '2026-10-27T00:00:00Z', 'outcome': 'failed'}
    assert not validator.is_valid(checked)
    assert validator.is_valid({**checked, 'reasons': ['request_failed']})
    assert not validator.is_valid({**checked, 'outcome': 'partial', 'coverage': 'complete', 'reasons': []})


def test_scan_contract_operation_surface():
    document = yaml.safe_load(Path('openapi.yaml').read_text(encoding='utf-8'))
    paths = {path for path in document['paths'] if path.startswith('/api/scan/')}
    assert paths == {'/api/scan/runs', '/api/scan/runs/{runId}',
                     '/api/scan/runs/{runId}/cancel', '/api/scan/claim',
                     '/api/scan/renew', '/api/scan/finish', '/api/scan/jobs/{jobId}/pages'}
