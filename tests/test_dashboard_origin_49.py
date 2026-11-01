"""#49 approved HTTPS dashboard origin: exact CORS and Private Network Access for the Pages origin only."""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import DASHBOARD_ORIGIN, create_app
from backend.storage import InMemoryStore

ROOT = Path(__file__).parents[1]
PAGES = 'https://ramung55.github.io'


def client():
    return TestClient(create_app(InMemoryStore()), base_url='http://127.0.0.1:8000')


def preflight(c, origin, private=True):
    headers = {'Origin': origin, 'Access-Control-Request-Method': 'POST',
               'Access-Control-Request-Headers': 'content-type,x-moodle-helper-bridge-binding'}
    if private:
        headers['Access-Control-Request-Private-Network'] = 'true'
    return c.options('/api/ai/extract', headers=headers)


def test_origin_constant_is_the_approved_pages_origin():
    assert DASHBOARD_ORIGIN == PAGES


def test_pages_origin_gets_cors_and_private_network_preflight():
    response = preflight(client(), PAGES)
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == PAGES
    assert response.headers['access-control-allow-private-network'] == 'true'
    assert 'access-control-allow-credentials' not in response.headers
    assert 'x-moodle-helper-bridge-binding' in response.headers['access-control-allow-headers'].lower()


def test_other_origins_preflight_is_rejected():
    # Starlette may still echo Allow-Private-Network on a rejected preflight; without
    # Allow-Origin the browser blocks the request, so the rejection is what matters.
    c = client()
    for origin in ('https://evil.example', 'http://ramung55.github.io', 'https://ramung55.github.io.evil.example', 'null'):
        for private in (True, False):
            response = preflight(c, origin, private)
            assert response.status_code == 400, origin
            assert 'access-control-allow-origin' not in response.headers, origin


def test_simple_get_from_pages_is_readable_and_others_are_not():
    c = client()
    assert c.get('/api/bridge-context', headers={'Origin': PAGES}).headers['access-control-allow-origin'] == PAGES
    assert 'access-control-allow-origin' not in c.get('/api/bridge-context', headers={'Origin': 'https://evil.example'}).headers


def test_loopback_host_check_still_runs_first_for_the_pages_origin():
    c = TestClient(create_app(InMemoryStore()), base_url='http://moodle-helper.attacker.example')
    assert c.get('/api/bridge-context', headers={'Origin': PAGES}).status_code == 400


def test_extension_relay_is_limited_to_the_project_path():
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))
    relay = [c for c in manifest['content_scripts'] if c['js'] == ['dashboard-relay.js']][0]
    assert relay['matches'] == ['http://127.0.0.1:5173/*', 'http://localhost:5173/*', 'https://ramung55.github.io/MoodleHelper/*']
    assert manifest['host_permissions'] == ['http://127.0.0.1:8000/*', 'https://moodle.sdu.edu.kz/*']
