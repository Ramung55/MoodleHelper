"""#42 Groq provider (openai/gpt-oss-120b, free plan) behind the Provider protocol.

A fake opener replaces urllib, so these tests never touch the network (the autouse guard from
test_ai_gateway also refuses any non-loopback socket)."""

import asyncio
import email.message
import io
import json
import logging
import urllib.error

import pytest
from fastapi.testclient import TestClient

from backend.ai_gateway import (GROQ_MAX_BODY_BYTES, GROQ_MODELS, GROQ_RETENTION, GROQ_TOKENS_PER_MINUTE, GROQ_URL,
                                GROQ_USER_AGENT, MAX_OUTPUT_TOKENS, MAX_RESPONSE_BYTES, AiGateway, GroqProvider,
                                gateway_from_environment, groq_config, groq_fixed_input_bytes, groq_input_bound)
from backend.main import create_app
from backend.storage import InMemoryStore
from tests.test_ai_gateway import Clock, body, no_network, post  # noqa: F401  (autouse network guard)
from tools import run_ai_eval

KEY = 'gsk_TEST-SECRET-KEY-MARKER'
TEXT = 'Essay deadline 2027-03-12.'
MODEL = GROQ_MODELS[0]


def proposal_content(text=TEXT, **overrides):
    start = text.index('2027-03-12')
    item = {'title': 'Essay', 'type': 'assignment', 'date': {'precision': 'date', 'value': '2027-03-12'},
            'uncertain': False, 'uncertaintyReason': None, 'week': None,
            'evidence': [{'excerptId': 'ex-0', 'start': start, 'end': start + 10}]}
    item.update(overrides)
    return json.dumps({'proposals': [item]})


def envelope(content, finish='stop', usage=(700, 150), choices=1):
    data = {'id': 'chatcmpl-x', 'object': 'chat.completion',
            'choices': [{'index': i, 'finish_reason': finish, 'message': {'role': 'assistant', 'content': content}} for i in range(choices)]}
    if usage:
        data['usage'] = {'prompt_tokens': usage[0], 'completion_tokens': usage[1], 'total_tokens': sum(usage)}
    return json.dumps(data).encode()


class FakeResponse(io.BytesIO):
    status = 200


def http_error(status, retry_after=None, body=b'{"error":{"message":"leaky provider text sk-PROVIDER-MARKER"}}'):
    headers = email.message.Message()
    if retry_after is not None:
        headers['retry-after'] = str(retry_after)
    return urllib.error.HTTPError(GROQ_URL, status, 'provider says sk-PROVIDER-MARKER', headers, io.BytesIO(body))


class FakeOpener:
    """Records each urllib Request and answers with bytes or raises a prepared error."""

    def __init__(self, answer=None, error=None):
        self.answer = envelope(proposal_content()) if answer is None else answer
        self.error = error
        self.calls = []

    def __call__(self, req, timeout):
        self.calls.append({'url': req.full_url, 'method': req.get_method(), 'headers': dict(req.header_items()),
                           'body': json.loads(req.data), 'timeout': timeout})
        if self.error:
            raise self.error
        return FakeResponse(self.answer)


def make(tmp_path, opener, model=MODEL, **overrides):
    provider = GroqProvider(api_key=KEY, model=model, opener=opener)
    gateway = AiGateway(groq_config(str(tmp_path / 'ledger.sqlite3'), model, **overrides), provider, Clock())
    return TestClient(create_app(InMemoryStore(), ai_gateway=gateway)), gateway


def send(client, request_id='req-1', texts=(TEXT,), model=MODEL):
    return post(client, body(client, texts=texts, request_id=request_id, destination=f'groq:{model}', policy='groq-free-policy-1'))


def assert_no_leak(response, gateway, caplog):
    for marker in (KEY, 'SECRET', 'PROVIDER-MARKER', 'Essay deadline'):
        assert marker not in response.text
        assert marker not in caplog.text
        assert marker not in repr(gateway.ledger.rows())


def test_availability_names_groq_model_retention_and_3072_limit(tmp_path):
    client, _ = make(tmp_path, FakeOpener())
    info = client.get('/api/ai/availability').json()
    assert info['mode'] == 'groq' and info['destination'] == 'groq:openai/gpt-oss-120b'
    assert info['provider'] == 'Groq openai/gpt-oss-120b, free plan (external)'
    assert info['policyVersion'] == 'groq-free-policy-1' and info['retention'] == GROQ_RETENTION
    assert 'Groq' in info['retention'] and '30 days' in info['retention'] and 'training' in info['retention'] and '18+' in info['retention']
    assert len(info['retention']) <= 500  # the client schema bound
    limits = info['limits']
    assert limits['maxBodyBytes'] == GROQ_MAX_BODY_BYTES == 3072
    assert limits['monthlyCapUsd'] == 0 and limits['perRequestReserveUsd'] == 0 and limits['simulatedCost'] is False
    assert (limits['perMinute'], limits['perDay'], limits['concurrency'], limits['timeoutSeconds']) == (3, 20, 1, 30)


def test_valid_response_is_accepted_with_gateway_provenance(tmp_path, caplog):
    opener = FakeOpener()
    client, gateway = make(tmp_path, opener)
    with caplog.at_level(logging.DEBUG):
        response = send(client)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['mode'] == 'groq' and data['policyVersion'] == 'groq-free-policy-1'
    proposal = data['proposals'][0]
    assert proposal['confirmed'] is False and proposal['evidence'][0]['locationId'] == 'loc-0'
    assert 'week' not in proposal and 'uncertaintyReason' not in proposal  # nulls are treated as absent
    assert data['usage'] == {'inputTokens': 700, 'outputTokens': 150, 'costUsd': 0.0, 'simulated': False}
    assert gateway.ledger.rows()[0][2] == 'ok' and gateway.ledger.rows()[0][4] == 0.0
    assert KEY not in caplog.text and KEY not in repr(gateway.ledger.rows()) and KEY not in repr(gateway.provider)


def test_request_body_sends_only_excerpt_ids_text_and_context(tmp_path):
    opener = FakeOpener()
    client, _ = make(tmp_path, opener)
    assert send(client).status_code == 200
    call = opener.calls[0]
    assert call['url'] == GROQ_URL == 'https://api.groq.com/openai/v1/chat/completions' and call['method'] == 'POST'
    assert 0 < call['timeout'] <= 30
    headers = {k.lower(): v for k, v in call['headers'].items()}
    assert headers['authorization'] == f'Bearer {KEY}' and headers['content-type'] == 'application/json'
    assert headers['user-agent'] == GROQ_USER_AGENT and 'python-urllib' not in headers['user-agent'].lower()
    sent = call['body']
    assert sent['model'] == MODEL and sent['n'] == 1 and sent['stream'] is False and sent['temperature'] == 0
    assert sent['max_completion_tokens'] == MAX_OUTPUT_TOKENS == 2000
    assert sent['reasoning_effort'] == 'low' and sent['include_reasoning'] is False
    assert not {'tools', 'tool_choice', 'logprobs', 'logit_bias'} & set(sent)
    fmt = sent['response_format']
    assert fmt['type'] == 'json_schema' and fmt['json_schema']['strict'] is True and fmt['json_schema']['name'] == 'ai_extract_v1'
    assert [m['role'] for m in sent['messages']] == ['system', 'user'] and all('name' not in m for m in sent['messages'])
    assert json.loads(sent['messages'][1]['content']) == {'excerpts': [{'id': 'ex-0', 'text': TEXT}], 'context': {}}
    raw = json.dumps(sent)
    assert 'loc-0' not in raw and 'documentDigest' not in raw and 'a' * 64 not in raw and 'payloadDigest' not in raw


def test_strict_schema_is_closed_and_requires_every_property():
    schema = GroqProvider(api_key=KEY, opener=FakeOpener()).request_body({'excerpts': [{'id': 'e', 'text': 't'}]}, 2000)['response_format']['json_schema']['schema']

    def walk(node):
        if isinstance(node, dict):
            if node.get('type') == 'object':
                assert node['additionalProperties'] is False and set(node['required']) == set(node['properties'])
            for value in node.values():
                walk(value)
    walk(schema)
    item = schema['properties']['proposals']['items']['properties']
    assert 'confirmed' not in item and 'locationId' not in item['evidence']['items']['properties']


def test_rate_limit_429_maps_with_retry_after_and_is_not_retried(tmp_path, caplog):
    opener = FakeOpener(error=http_error(429, retry_after=10**9))
    client, gateway = make(tmp_path, opener)
    response = send(client)
    assert response.status_code == 429 and 'code: rate_limit' in response.json()['message']
    assert response.headers['retry-after'] == '86400'  # capped
    assert len(opener.calls) == 1 and gateway.ledger.rows()[0][2] == 'rate_limit'
    assert_no_leak(response, gateway, caplog)


@pytest.mark.parametrize('opener, status, code', [
    (FakeOpener(error=http_error(401)), 502, 'provider_failure'),
    (FakeOpener(error=http_error(403)), 502, 'provider_failure'),
    (FakeOpener(error=http_error(400, body=b'{"error":{"message":"Generated JSON does not match the expected schema"}}')), 502, 'invalid_output'),
    (FakeOpener(error=http_error(413)), 502, 'provider_failure'),
    (FakeOpener(error=http_error(503)), 502, 'provider_failure'),
    (FakeOpener(error=http_error(302)), 502, 'provider_failure'),
    (FakeOpener(error=urllib.error.URLError('dns sk-PROVIDER-MARKER')), 502, 'provider_failure'),
    (FakeOpener(error=TimeoutError('read timed out')), 504, 'timeout'),
    (FakeOpener(envelope(proposal_content(), finish='length')), 502, 'provider_failure'),
    (FakeOpener(envelope(proposal_content(), choices=2)), 502, 'provider_failure'),
    (FakeOpener(envelope(None)), 502, 'provider_failure'),
    (FakeOpener(b'<html>not json sk-PROVIDER-MARKER</html>'), 502, 'provider_failure'),
    (FakeOpener(envelope(proposal_content()) + b' ' * MAX_RESPONSE_BYTES), 502, 'invalid_output'),
    (FakeOpener(envelope('Sure! sk-PROVIDER-MARKER')), 502, 'invalid_output'),
    (FakeOpener(envelope(proposal_content(evidence=[{'excerptId': 'ex-9', 'start': 0, 'end': 3}]))), 502, 'invalid_output'),
])
def test_provider_defects_fail_closed_without_leaking(tmp_path, caplog, opener, status, code):
    client, gateway = make(tmp_path, opener)
    with caplog.at_level(logging.DEBUG):
        response = send(client)
    assert response.status_code == status and f'code: {code}' in response.json()['message']
    assert len(opener.calls) == 1  # never retried
    assert gateway.ledger.rows()[0][2] == code
    assert_no_leak(response, gateway, caplog)


def test_ledger_rate_limit_stops_before_any_call(tmp_path):
    opener = FakeOpener()
    client, _ = make(tmp_path, opener)
    for i in range(3):
        assert send(client, request_id=f'req-{i}').status_code == 200
    blocked = send(client, request_id='req-3')
    assert blocked.status_code == 429 and 'code: rate_limit' in blocked.json()['message']
    assert len(opener.calls) == 3


def test_model_change_changes_destination_and_needs_new_consent(tmp_path):
    opener = FakeOpener()
    client, _ = make(tmp_path, opener, model='openai/gpt-oss-20b')
    assert client.get('/api/ai/availability').json()['destination'] == 'groq:openai/gpt-oss-20b'
    stale = send(client, model='openai/gpt-oss-120b')  # consent given for the other model
    assert stale.status_code == 422 and 'consent_mismatch' in stale.json()['message'] and not opener.calls
    assert send(client, request_id='req-2', model='openai/gpt-oss-20b').status_code == 200
    assert opener.calls[0]['body']['model'] == 'openai/gpt-oss-20b'


def test_body_over_3072_bytes_is_rejected_before_any_call(tmp_path):
    opener = FakeOpener()
    client, _ = make(tmp_path, opener)
    response = send(client, texts=('q' * 1500, 'w' * 1500))
    assert response.status_code == 413 and 'payload_too_large' in response.json()['message'] and not opener.calls


def test_token_bound_fits_the_free_plan_tokens_per_minute():
    # Each byte-level BPE token covers >= 1 UTF-8 byte, so bytes bound tokens. The user message is a
    # strict subset of the request body, so a 3072 B body bounds it too.
    assert groq_fixed_input_bytes() + GROQ_MAX_BODY_BYTES + MAX_OUTPUT_TOKENS <= GROQ_TOKENS_PER_MINUTE == 8000
    context = {'dateOrder': 'DMY', 'timezone': 'Asia/Almaty', 'explicitSemesterBounds': {'start': '2026-09-01', 'end': '2026-12-20'}}
    excerpts = [{'id': f'ex-{i}', 'documentDigest': 'a' * 64, 'locationId': f'loc-{i}', 'text': 'Ж"\\' * 180} for i in range(2)]
    wire = {'version': 'ai-extract.v1', 'requestId': 'r' * 128, 'expectedDatasetId': 'd',
            'consent': {'policyVersion': 'groq-free-policy-1', 'destination': f'groq:{MODEL}', 'approvedExcerptIds': ['ex-0', 'ex-1'],
                        'payloadDigest': 'b' * 64}, 'excerpts': excerpts, 'context': context}
    body_bytes = len(json.dumps(wire, ensure_ascii=False, separators=(',', ':')).encode())
    assert body_bytes <= GROQ_MAX_BODY_BYTES
    assert groq_input_bound({'excerpts': excerpts, 'context': context}) <= groq_fixed_input_bytes() + body_bytes


def test_environment_selection_is_opt_in_and_model_is_allowlisted(tmp_path):
    ledger = str(tmp_path / 'l.sqlite3')
    assert not gateway_from_environment({}).enabled
    assert not gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'groq'}).enabled  # no key
    assert not gateway_from_environment({'GROQ_API_KEY': KEY}).enabled  # not selected
    assert not gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'openai', 'GROQ_API_KEY': KEY}).enabled
    with pytest.raises(ValueError):
        gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'groq', 'GROQ_API_KEY': KEY})  # no ledger
    with pytest.raises(ValueError) as error:
        gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'groq', 'GROQ_API_KEY': KEY, 'MOODLE_HELPER_AI_LEDGER_PATH': ledger,
                                  'MOODLE_HELPER_AI_MODEL': 'qwen/qwen3.8-27b'})
    assert KEY not in str(error.value)
    gateway = gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'groq', 'GROQ_API_KEY': KEY, 'MOODLE_HELPER_AI_LEDGER_PATH': ledger})
    try:
        assert gateway.enabled and isinstance(gateway.provider, GroqProvider) and gateway.provider.model == MODEL
        assert gateway.config.monthly_cap_usd == 0.0 and gateway.config.destination == 'groq:openai/gpt-oss-120b'
    finally:
        gateway.close()


def test_eval_runner_without_key_sends_nothing(tmp_path, capsys):
    results = tmp_path / 'results.json'
    assert asyncio.run(run_ai_eval.main([], env={}, results=results)) == 2
    assert 'GROQ_API_KEY is not set; nothing was sent.' in capsys.readouterr().out and not results.exists()


def test_eval_runner_records_groq_run_with_spacing_and_rate_limit(tmp_path):
    answers = iter([http_error(429, retry_after=5)] + [None] * 20)

    class Opener(FakeOpener):
        def __call__(self, req, timeout):
            self.error = next(answers)
            self.answer = envelope(json.dumps({'proposals': []}), usage=(300, 20))
            return super().__call__(req, timeout)
    opener, sleeps, results = Opener(), [], tmp_path / 'results.json'

    async def sleep(seconds):
        sleeps.append(seconds)
    assert asyncio.run(run_ai_eval.main([], env={'GROQ_API_KEY': KEY}, results=results, sleep=sleep, opener=opener)) == 0
    data = json.loads(results.read_text(encoding='utf-8'))
    assert (data['provider'], data['model'], data['tier'], data['reasoningEffort'], data['totalCostUsd']) == ('groq', MODEL, 'free', 'low', 0)
    assert data['priceTable'] == 'groq-free-2026-11-03' and data['ranAt'].endswith('+00:00')
    assert len(data['cases']) == 7 and data['cases'][0]['failed'] == ['rate_limit:429'] and len(opener.calls) == 7
    assert data['cases'][-1] == {'id': 'no-date', 'lang': data['cases'][-1]['lang'], 'outcome': 'pass', 'failed': [], 'proposals': [],
                                 'inputTokens': 300, 'outputTokens': 20, 'costUsd': 0.0}
    assert sleeps == [21] * 6
    assert KEY not in results.read_text(encoding='utf-8')


def test_groq_key_name_is_absent_from_browser_sources():
    from tests.test_ai_gateway import ROOT
    for folder in ('frontend/src', 'shared/src', 'extension/src'):
        for path in (ROOT / folder).rglob('*.ts*'):
            text = path.read_text(encoding='utf-8', errors='ignore')
            assert 'GROQ_API_KEY' not in text and 'api.groq.com' not in text, path
