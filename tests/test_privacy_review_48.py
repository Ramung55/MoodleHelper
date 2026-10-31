"""#48 privacy/permissions review probes (evidence only; no production changes).

Pins the reviewed permission inventory and the backend binding boundary, and
records confirmed findings as strict xfails so a fix flips them to failures
that force this file (and _docs/reviews/privacy-permissions.md) to be updated.
"""
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.storage import InMemoryStore

ROOT = Path(__file__).resolve().parents[1]
EVIL = {'origin': 'https://evil.example', 'content-type': 'text/plain'}


def manifest(path):
    return json.loads((ROOT / path).read_text(encoding='utf-8'))


@pytest.mark.parametrize('path', ['extension/manifest.json', 'extension/dist/manifest.json'])
def test_manifest_matches_reviewed_inventory(path):
    m = manifest(path)
    assert m['manifest_version'] == 3 and m['minimum_chrome_version'] == '106'
    assert sorted(m['permissions']) == ['alarms', 'downloads', 'notifications']
    assert sorted(m['host_permissions']) == ['http://127.0.0.1:8000/*', 'https://moodle.sdu.edu.kz/*']
    assert [c['matches'] for c in m['content_scripts']] == [
        ['https://moodle.sdu.edu.kz/*'], ['http://127.0.0.1:5173/*', 'http://localhost:5173/*']]
    assert 'optional_permissions' not in m and 'externally_connectable' not in m
    assert 'web_accessible_resources' not in m


def test_bridge_allowlist_equals_dashboard_content_script_matches():
    src = (ROOT / 'shared/src/bridge.ts').read_text(encoding='utf-8')
    origins = json.loads(re.search(r'APPROVED_ORIGINS = (\[[^\]]*\])', src).group(1))
    relay = manifest('extension/manifest.json')['content_scripts'][1]['matches']
    assert [o + '/*' for o in origins] == relay
    assert all(o.startswith('http://') for o in origins)  # no approved HTTPS origin


def _ops(client):
    for path, ops in client.get('/openapi.json').json()['paths'].items():
        for method in ops:
            yield method.upper(), path, re.sub(r'\{[^}]+\}', 'x', path)


BOUND_PREFIXES = ('/api/ai/', '/api/backups/restore', '/api/local-data/erase', '/api/reminders/',
                  '/api/material-downloads', '/api/queue/', '/api/scan/', '/api/collection/',
                  '/api/local-syllabus/route')


def test_bound_writes_reject_missing_binding_before_work():
    with TestClient(create_app(InMemoryStore()), bind_writes=False) as client:
        checked = 0
        for method, path, concrete in _ops(client):
            if method == 'GET' or not path.startswith(BOUND_PREFIXES):
                continue
            response = client.request(method, concrete, content=b'{}', headers=EVIL)
            assert response.status_code == 409, (method, path, response.status_code)
            checked += 1
        assert checked >= 20


def test_no_cors_grant_to_foreign_origin():
    with TestClient(create_app(InMemoryStore())) as client:
        for path in ['/api/snapshot', '/api/bridge-context']:
            assert 'access-control-allow-origin' not in client.get(path, headers={'origin': 'https://evil.example'}).headers
        for path in ['/api/ai/extract', '/api/demo/reset', '/api/sync']:
            preflight = client.options(path, headers={'origin': 'https://evil.example',
                                                      'access-control-request-method': 'POST',
                                                      'access-control-request-headers': 'x-moodle-helper-bridge-binding'})
            assert 'access-control-allow-origin' not in preflight.headers, path


def test_ai_provider_inactive_by_default():
    with TestClient(create_app(InMemoryStore())) as client:
        body = client.get('/api/ai/availability').json()
        assert body['available'] is False


def test_finding_f1_demo_reset_rejects_cross_site_simple_post():
    # Fixed by #62: the reproduction is rejected and nothing changes.
    with TestClient(create_app(InMemoryStore()), bind_writes=False) as client:
        before = client.get('/api/snapshot').json()
        assert client.post('/api/demo/reset', headers=EVIL).status_code == 409
        assert client.get('/api/snapshot').json() == before


# #62: no non-GET operation is exempt. Any future exemption must be listed here
# with a comment proving the route never writes.
UNBOUND_WRITE_ALLOWLIST: frozenset[tuple[str, str]] = frozenset()


def test_every_non_get_operation_rejects_unbound_cross_site_simple_request():
    with TestClient(create_app(InMemoryStore()), bind_writes=False) as client:
        before = client.get('/api/snapshot').json()
        checked = 0
        for method, path, concrete in _ops(client):
            if method in ('GET', 'HEAD') or (method, path) in UNBOUND_WRITE_ALLOWLIST:
                continue
            for body in (b'', b'{}', b'plain text'):
                response = client.request(method, concrete, content=body, headers=EVIL)
                assert response.status_code == 409, (method, path, body, response.status_code)
                assert set(response.json()) == {'message'}
            checked += 1
        assert checked >= 40
        assert client.get('/api/snapshot').json() == before


@pytest.mark.xfail(strict=True, reason='#48 finding F2: no Host validation, DNS-rebinding reads possible')
def test_finding_f2_foreign_host_header_rejected():
    with TestClient(create_app(InMemoryStore())) as client:
        assert client.get('/api/snapshot', headers={'host': 'attacker.example:8000'}).status_code == 400
