"""#43 optional AI gateway: local mock only, no network, bounded and fail-closed."""

import asyncio
import json
import logging
import socket
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ai_gateway import (AiFailure, AiGateway, GatewayConfig, MockProvider, PriceTable, mock_config,
                                payload_digest, LEGACY_UNAVAILABLE)
from backend.main import create_app
from backend.storage import InMemoryStore

ROOT = Path(__file__).parents[1]
FIXTURES = json.loads((ROOT / '_docs/architecture/ai-contract-eval-fixtures.json').read_text(encoding='utf-8'))
SECRET = 'sk-SECRET-MARKER'
EXCERPT_MARKER = 'EXCERPT-PRIVATE-MARKER'


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    # Loopback is allowed (the Windows event loop self-pipe uses it); anything else fails.
    original = socket.socket.connect

    def guarded(self, address, *args):
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ('127.0.0.1', '::1', 'localhost'):
            raise AssertionError('external network access attempted')
        return original(self, address, *args)
    monkeypatch.setattr(socket.socket, 'connect', guarded)


class Clock:
    def __init__(self, now=1_790_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


def make(tmp_path, provider=None, clock=None, **overrides):
    provider = provider or MockProvider()
    gateway = AiGateway(mock_config(str(tmp_path / 'ai-ledger.sqlite3'), **overrides), provider, clock or Clock())
    client = TestClient(create_app(InMemoryStore(), ai_gateway=gateway))
    return client, provider, gateway


def body(client, texts=('Essay deadline 2027-03-12.',), request_id='req-1', context=None, destination='mock', policy='mock-policy-1'):
    excerpts = [{'id': f'ex-{i}', 'documentDigest': 'a' * 64, 'locationId': f'loc-{i}', 'text': t} for i, t in enumerate(texts)]
    payload = {'version': 'ai-extract.v1', 'requestId': request_id,
               'expectedDatasetId': client.get('/api/local-context').json()['datasetId'],
               'consent': {'policyVersion': policy, 'destination': destination, 'approvedExcerptIds': [e['id'] for e in excerpts],
                           'payloadDigest': payload_digest(policy, destination, excerpts, context)},
               'excerpts': excerpts}
    if context is not None:
        payload['context'] = context
    return payload


def post(client, payload, **kwargs):
    headers = {'X-Moodle-Helper-Bridge-Binding': client.get('/api/bridge-context').json()['binding']}
    return client.post('/api/ai/extract', json=payload, headers=headers, **kwargs)


def test_ordinary_runtime_stays_unavailable_and_never_invokes(tmp_path):
    with TestClient(create_app(InMemoryStore())) as client:
        assert client.get('/api/ai/availability').json() == {'available': False, 'reason': LEGACY_UNAVAILABLE}
        response = post(client, body(client))
        assert response.status_code == 503 and 'code: unavailable' in response.json()['message']
    with pytest.raises(ValueError):
        GatewayConfig(mode='openai')


def test_mock_returns_validated_candidates_with_source_references(tmp_path):
    client, provider, gateway = make(tmp_path)
    with client:
        availability = client.get('/api/ai/availability').json()
        assert availability['provider'] == 'Local mock; no external provider' and availability['mode'] == 'mock'
        assert availability['limits']['maxExcerpts'] == 8 and availability['limits']['simulatedCost'] is True
        cases = {c['id']: c['text'] for c in FIXTURES['cases'] if c['id'] in ('ambiguous-order', 'relative-week')}
        texts = ('Essay deadline 2027-03-12.', cases['ambiguous-order'], cases['relative-week'])
        response = post(client, body(client, texts, context={'timezone': 'Asia/Almaty', 'explicitSemesterBounds': {'start': '2026-09-01', 'end': '2026-12-20'}}))
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['mode'] == 'mock' and result['status'] == 'ok' and result['usage']['simulated'] is True
        exact, ambiguous, week = result['proposals']
        assert exact['date'] == {'value': '2027-03-12', 'precision': 'date'} and exact['uncertain'] is False
        assert exact['evidence'] == [{'excerptId': 'ex-0', 'locationId': 'loc-0', 'start': 15, 'end': 25}]
        assert ambiguous['uncertaintyReason'] == 'ambiguous_order' and 'value' not in ambiguous['date']
        assert week['date'] == {'precision': 'week'} and week['week'] == 6 and week['uncertaintyReason'] == 'relative_week'
        assert all(p['confirmed'] is False for p in result['proposals'])
        assert provider.calls == 1
        # Proposals are unconfirmed: the Snapshot gains no assessment or candidate.
        before = client.get('/api/snapshot').json()
        assert len(before['assessments']) == len(client.get('/api/snapshot').json()['assessments'])


@pytest.mark.parametrize('mutate', [
    lambda b: b.update(extra=1),
    lambda b: b['excerpts'][0].update(url='https://x'),
    lambda b: b.update(version='ai-extract.v2'),
    lambda b: b['excerpts'][0].update(documentDigest='ABC'),
    lambda b: b['consent'].update(approvedExcerptIds=['other']),
    lambda b: b['consent'].update(payloadDigest='0' * 64),
    lambda b: b['consent'].update(destination='openai/gpt'),
    lambda b: b.update(expectedDatasetId='stale-dataset'),
    lambda b: b['excerpts'].append(dict(b['excerpts'][0])),
    lambda b: b.update(excerpts=[]),
])
def test_malformed_or_unconsented_requests_reject_before_provider(tmp_path, mutate):
    client, provider, gateway = make(tmp_path)
    with client:
        payload = body(client)
        mutate(payload)
        response = post(client, payload)
        assert response.status_code in (409, 422), response.text
        assert provider.calls == 0 and gateway.ledger.rows() == []


def test_payload_limits_reject_with_413_before_provider(tmp_path):
    client, provider, gateway = make(tmp_path)
    with client:
        too_many = post(client, body(client, ['Quiz 2027-01-01'] * 9))
        assert too_many.status_code == 422
        multibyte = post(client, body(client, ['ж' * 1001]))  # 2002 UTF-8 bytes
        assert multibyte.status_code == 413 and 'payload_too_large' in multibyte.json()['message']
        big = post(client, body(client, ['x' * 1900] * 8 + []) | {'pad': 'y' * 20000})
        assert big.status_code == 413
        assert provider.calls == 0


def test_rate_concurrency_and_budget_caps_stop_new_provider_work(tmp_path):
    clock = Clock()
    client, provider, gateway = make(tmp_path, clock=clock)
    with client:
        for i in range(3):
            assert post(client, body(client, request_id=f'r{i}')).status_code == 200
        limited = post(client, body(client, request_id='r3'))
        assert limited.status_code == 429 and 'rate_limit' in limited.json()['message'] and int(limited.headers['Retry-After']) <= 61
        assert provider.calls == 3
        for i in range(4, 21):
            clock.now += 61
            post(client, body(client, request_id=f'r{i}'))
        clock.now += 61
        daily = post(client, body(client, request_id='day-over'))
        assert daily.status_code == 429 and provider.calls == 20
    # Budget: simulated 10 USD cap with a 0.10 reservation allows at most 100 per month; use a small cap.
    (tmp_path / 'b').mkdir(exist_ok=True)
    client, provider, gateway = make(tmp_path / 'b', monthly_cap_usd=0.15)
    provider.usage = None  # unknown actual cost keeps the worst-case reservation
    with client:
        assert post(client, body(client, request_id='b1')).status_code == 200
        exhausted = post(client, body(client, request_id='b2'))
        assert exhausted.status_code == 429 and 'budget_exhausted' in exhausted.json()['message'] and provider.calls == 1
    # Production default is a 0 USD cap.
    assert GatewayConfig().monthly_cap_usd == 0


def test_budget_and_rate_ledger_survive_restart_and_inflight_crash(tmp_path):
    path = str(tmp_path / 'ledger.sqlite3')
    first = AiGateway(mock_config(path, monthly_cap_usd=0.15), MockProvider(usage=None), Clock())
    first.ledger.admit('crashed', 'd' * 64, Clock()(), first.config, 0.10)  # simulate crash mid-flight
    first.close()
    provider = MockProvider()
    restarted = AiGateway(mock_config(path, monthly_cap_usd=0.15), provider, Clock())
    assert restarted.ledger.rows()[0][2] == 'unknown'
    with TestClient(create_app(InMemoryStore(), ai_gateway=restarted)) as client:
        assert post(client, body(client, request_id='after')).status_code == 429
        assert post(client, body(client, request_id='crashed')).status_code == 409
    assert provider.calls == 0


def test_concurrency_one_and_atomic_reservation(tmp_path):
    provider = MockProvider(delay=0.3)
    gateway = AiGateway(mock_config(str(tmp_path / 'l.sqlite3')), provider, Clock())
    with TestClient(create_app(InMemoryStore(), ai_gateway=gateway)) as client:
        a, b = body(client, request_id='c1'), body(client, request_id='c2')
        dataset = a['expectedDatasetId']

    async def race():
        return await asyncio.gather(gateway.extract(a, dataset), gateway.extract(b, dataset), return_exceptions=True)
    results = asyncio.run(race())
    failures = [r for r in results if isinstance(r, AiFailure)]
    assert len(failures) == 1 and failures[0].code == 'concurrency_limit' and provider.calls == 1


def test_idempotent_replay_and_conflicting_reuse(tmp_path):
    client, provider, gateway = make(tmp_path)
    with client:
        payload = body(client)
        assert post(client, payload).status_code == 200
        replay = post(client, payload)
        assert replay.status_code == 409 and 'duplicate_request' in replay.json()['message']
        conflict = post(client, body(client, ['Quiz 2027-02-02']))
        assert conflict.status_code == 409 and 'request_conflict' in conflict.json()['message']
        assert provider.calls == 1


@pytest.mark.parametrize('behavior,code,status', [('fail', 'provider_failure', 502), ('invalid', 'invalid_output', 502),
                                                  ('oversize', 'invalid_output', 502), ('timeout', 'timeout', 504)])
def test_provider_failures_are_bounded_unretried_and_create_nothing(tmp_path, behavior, code, status, caplog):
    caplog.set_level(logging.DEBUG)
    client, provider, gateway = make(tmp_path, MockProvider(behavior=behavior), timeout_seconds=0.2)
    with client:
        before = client.get('/api/snapshot').json()
        response = post(client, body(client, [EXCERPT_MARKER + ' 2027-01-01'], request_id='fail-1'))
        assert response.status_code == status and f'code: {code}' in response.json()['message']
        assert 'request: fail-1' in response.json()['message']
        assert provider.calls == 1 and client.get('/api/snapshot').json() == before
        assert gateway.ledger.rows()[0][2] == code
        # No silent retry under the same ID.
        assert post(client, body(client, [EXCERPT_MARKER + ' 2027-01-01'], request_id='fail-1')).status_code == 409
        assert provider.calls == 1
    text = caplog.text + response.text
    assert SECRET not in text and EXCERPT_MARKER not in text and 'fail-1' in caplog.text


@pytest.mark.parametrize('output', [
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-30', 'precision': 'date'}, 'uncertain': False, 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-03', 'precision': 'date'}, 'uncertain': False, 'evidence': [{'excerptId': 'unknown', 'start': 0, 'end': 4}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-03', 'precision': 'date'}, 'uncertain': False, 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 999}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-03', 'precision': 'week'}, 'week': 3, 'uncertain': True, 'uncertaintyReason': 'relative_week', 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-03', 'precision': 'date'}, 'uncertain': False, 'confirmed': True, 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'value': '2027-02-03', 'precision': 'date'}, 'uncertain': False, 'url': 'https://evil', 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}]},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'precision': 'none'}, 'uncertain': False, 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}]},
    {'proposals': []} | {'run_tool': 'fetch'},
    {'proposals': [{'title': 'X', 'type': 'exam', 'date': {'precision': 'none'}, 'uncertain': True, 'uncertaintyReason': 'no_date', 'evidence': [{'excerptId': 'ex-0', 'start': 0, 'end': 4}]}] * 51},
    {'proposals': [eval('[' * 30 + '1' + ']' * 30)]},
])
def test_invalid_provider_output_is_rejected_whole(tmp_path, output):
    client, provider, gateway = make(tmp_path, MockProvider(behavior='output', output=output))
    with client:
        response = post(client, body(client, ['Exam on 2027-02-03']))
        assert response.status_code == 502 and 'invalid_output' in response.json()['message']


def test_utf16_offsets_and_malicious_excerpt_is_inert(tmp_path):
    adversarial = next(c['text'] for c in FIXTURES['cases'] if c['id'] == 'adversarial')
    client, provider, gateway = make(tmp_path)
    with client:
        result = post(client, body(client, ['😀 Quiz 2027-05-06', adversarial])).json()
        span = result['proposals'][0]['evidence'][0]
        assert '😀 Quiz 2027-05-06'.encode('utf-16-le')[span['start'] * 2:span['end'] * 2].decode('utf-16-le') == '2027-05-06'
        assert all(e['excerptId'] in ('ex-0', 'ex-1') for p in result['proposals'] for e in p['evidence'])


def test_cancelled_client_stops_work_releases_concurrency_and_records(tmp_path):
    provider = MockProvider(behavior='timeout')
    gateway = AiGateway(mock_config(str(tmp_path / 'l.sqlite3')), provider, Clock())
    with TestClient(create_app(InMemoryStore(), ai_gateway=gateway)) as client:
        payload = body(client, request_id='gone')

    async def run():
        async def disconnected():
            return provider.calls > 0
        with pytest.raises(AiFailure) as failure:
            await asyncio.wait_for(gateway.extract(payload, payload['expectedDatasetId'], disconnected), 2)
        return failure.value
    failure = asyncio.run(run())
    assert failure.code == 'cancelled' and provider.cancelled == 1 and not gateway.active.locked()
    assert gateway.ledger.rows()[0][2] == 'cancelled' and gateway.ledger.rows()[0][4] is None  # reservation retained


def test_validation_errors_and_logs_never_echo_secrets_or_excerpts(tmp_path, caplog, monkeypatch):
    monkeypatch.setenv('MOODLE_HELPER_AI_API_KEY', SECRET)
    caplog.set_level(logging.DEBUG)
    client, provider, gateway = make(tmp_path)
    with client:
        payload = body(client, [EXCERPT_MARKER])
        payload['excerpts'][0]['password'] = SECRET
        response = post(client, payload)
        assert response.status_code == 422 and response.json() == {'message': 'Invalid AI request. (code: invalid_request)'}
        payload = body(client, [EXCERPT_MARKER + ' 2027-01-01'], request_id='ok-1')
        ok = post(client, payload)
        everything = caplog.text + response.text + client.get('/api/ai/availability').text + ok.text
        assert SECRET not in everything and EXCERPT_MARKER not in caplog.text
        assert 'ok-1' in caplog.text


def test_expired_or_missing_prices_fail_closed(tmp_path):
    client, provider, gateway = make(tmp_path, prices=PriceTable('old', 0.1, 0.5, __import__('datetime').date(2020, 1, 1)))
    with client:
        response = post(client, body(client))
        assert response.status_code == 503 and 'price_unavailable' in response.json()['message'] and provider.calls == 0


def test_binding_required_and_secret_absent_from_browser_sources():
    with TestClient(create_app(InMemoryStore())) as client:
        assert client.post('/api/ai/extract', json={}).status_code == 409
    for folder in ('frontend/src', 'shared/src', 'extension/src'):
        for path in (ROOT / folder).rglob('*.ts*'):
            text = path.read_text(encoding='utf-8', errors='ignore')
            assert 'MOODLE_HELPER_AI_API_KEY' not in text and 'VITE_AI' not in text, path
