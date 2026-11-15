"""#63: only loopback Host names are answered; everything else is 400 before routing."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app
from backend.storage import InMemoryStore

ALLOWED = ['127.0.0.1', '127.0.0.1:8000', '127.0.0.1:5173', '127.0.0.1:8123', 'localhost', 'localhost:8000',
           'localhost:5173', 'LOCALHOST:8000', 'LocalHost', '[::1]', '[::1]:8000']
REJECTED = ['attacker.example:8000', 'attacker.example', '127.0.0.1.attacker.example', 'localhost.attacker.example',
            '0.0.0.0:8000', '192.168.1.10:8000', '10.0.0.5', '', 'localhost.', 'localhost.:8000', '::1', '::1:8000',
            '127.0.0.1:', '127.0.0.1:abc', '127.0.0.1:8000:1', 'testserver', '127.0.0.2:8000', '[::2]:8000']
PATHS = ['/api/bridge-context', '/api/snapshot', '/docs', '/openapi.json', '/api/does-not-exist']


@pytest.fixture(scope='module')
def client():
    with TestClient(create_app(InMemoryStore())) as client:
        yield client


@pytest.mark.parametrize('host', ALLOWED)
@pytest.mark.parametrize('path', PATHS[:4])
def test_loopback_hosts_are_answered(client, host, path):
    assert client.get(path, headers={'host': host}).status_code == 200


@pytest.mark.parametrize('host', REJECTED)
@pytest.mark.parametrize('path', PATHS)
def test_other_hosts_get_400_before_routing(client, host, path):
    response = client.get(path, headers={'host': host})
    assert response.status_code == 400
    assert response.json() == {'message': 'Invalid Host header. Use 127.0.0.1, localhost or [::1].'}
    assert 'binding' not in response.text


@pytest.mark.parametrize('host', REJECTED[:3])
def test_bad_host_preflight_and_writes_get_400(client, host):
    preflight = client.options('/api/demo/reset', headers={'host': host, 'origin': 'http://attacker.example',
                                                           'access-control-request-method': 'POST'})
    assert preflight.status_code == 400
    binding = client.get('/api/bridge-context').json()['binding']
    before = client.get('/api/snapshot').json()
    write = client.post('/api/demo/reset', headers={'host': host, 'X-Moodle-Helper-Bridge-Binding': binding})
    assert write.status_code == 400
    assert client.get('/api/snapshot').json() == before


def test_forwarded_host_headers_do_not_bypass(client):
    headers = {'host': 'attacker.example', 'x-forwarded-host': '127.0.0.1:8000', 'forwarded': 'host=127.0.0.1'}
    assert client.get('/api/snapshot', headers=headers).status_code == 400
    assert client.get('/api/snapshot', headers={'x-forwarded-host': 'attacker.example'}).status_code == 200


def raw_status(app, headers, path='/api/snapshot'):
    sent = []

    async def receive():
        return {'type': 'http.request', 'body': b'', 'more_body': False}

    async def send(message):
        sent.append(message)

    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'GET', 'scheme': 'http',
             'path': path, 'raw_path': path.encode(), 'query_string': b'', 'root_path': '', 'headers': headers,
             'client': ('127.0.0.1', 1), 'server': ('127.0.0.1', 8000)}
    asyncio.run(app(scope, receive, send))
    return sent[0]['status']


def test_missing_or_duplicate_host_is_400_at_the_asgi_boundary():
    app = create_app(InMemoryStore())
    assert raw_status(app, []) == 400
    assert raw_status(app, [(b'host', b'127.0.0.1:8000'), (b'host', b'attacker.example')]) == 400
    # Absolute-form request lines do not change the Host header the check reads.
    assert raw_status(app, [(b'host', b'attacker.example')], path='http://127.0.0.1:8000/api/snapshot') == 400
    assert raw_status(app, [(b'host', b'127.0.0.1:8000')]) == 200


# #135 hosted mode: one configured tailnet name besides loopback, exact match, no CORS grant.
NAME = 'mh.example-tailnet.ts.net'
HOSTED_REJECTED = [f'{NAME}.attacker.example', f'attacker.{NAME}', f'{NAME}.', f'{NAME}:443',
                   'other.example-tailnet.ts.net', 'attacker.example']
PAGES = 'https://ramung55.github.io'


@pytest.fixture(scope='module')
def hosted():
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv('MOODLE_HELPER_TAILNET_HOST', NAME.upper())
        app = create_app(InMemoryStore())
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize('host', [NAME, NAME.upper(), '127.0.0.1:8000', 'localhost', '[::1]:8000'])
def test_hosted_accepts_configured_name_and_loopback(hosted, host):
    assert hosted.get('/api/snapshot', headers={'host': host}).status_code == 200


@pytest.mark.parametrize('host', HOSTED_REJECTED)
def test_hosted_rejects_lookalikes_without_revealing_the_name(hosted, host):
    response = hosted.get('/api/snapshot', headers={'host': host})
    assert response.status_code == 400
    assert response.json() == {'message': 'Invalid Host header. Use 127.0.0.1, localhost or [::1].'}
    assert 'example-tailnet' not in response.text


def test_hosted_ignores_forwarded_host_and_rejects_missing_or_duplicate(hosted):
    assert hosted.get('/api/snapshot', headers={'host': 'attacker.example', 'x-forwarded-host': NAME}).status_code == 400
    app = hosted.app
    assert raw_status(app, []) == 400
    assert raw_status(app, [(b'host', NAME.encode()), (b'host', NAME.encode())]) == 400
    assert raw_status(app, [(b'host', NAME.encode())]) == 200


@pytest.mark.parametrize('host', HOSTED_REJECTED[:2])
def test_hosted_rejects_bad_host_websockets_with_1008(hosted, host):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as closed:
        with hosted.websocket_connect('/ws', headers={'host': host}):
            pass
    assert closed.value.code == 1008


def test_hosted_grants_no_cors_to_pages(hosted):
    host = {'host': NAME}
    for private in (True, False):
        headers = {**host, 'origin': PAGES, 'access-control-request-method': 'POST',
                   'access-control-request-headers': 'content-type,x-moodle-helper-bridge-binding'}
        if private:
            headers['access-control-request-private-network'] = 'true'
        assert 'access-control-allow-origin' not in hosted.options('/api/ai/extract', headers=headers).headers
        extra = {'access-control-request-private-network': 'true'} if private else {}
        assert 'access-control-allow-origin' not in hosted.get('/api/bridge-context', headers={**host, 'origin': PAGES, **extra}).headers


def test_hosted_writes_still_need_the_bridge_binding(hosted):
    host = {'host': NAME}
    before = hosted.get('/api/snapshot', headers=host).json()
    hosted.bind_writes = False
    try:
        assert hosted.post('/api/demo/reset', headers=host).status_code == 409
    finally:
        hosted.bind_writes = True
    assert hosted.get('/api/snapshot', headers=host).json() == before


@pytest.mark.parametrize('value', ['', '   ', '*.ts.net', f'https://{NAME}', f'{NAME}/', f'user@{NAME}',
                                   f'{NAME} ', f'mh .example.ts.net', f'{NAME}:443', f'{NAME}.', '.ts.net', 'a..ts.net'])
def test_invalid_tailnet_setting_stops_startup(monkeypatch, value):
    monkeypatch.setenv('MOODLE_HELPER_TAILNET_HOST', value)
    with pytest.raises(ValueError, match='MOODLE_HELPER_TAILNET_HOST'):
        create_app(InMemoryStore())
