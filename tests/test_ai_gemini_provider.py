"""#44 gemini-3.8-flash provider behind the Provider protocol. A fake SDK client keeps these tests offline."""

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.ai_gateway import AiGateway, GEMINI_MODEL, GEMINI_PROVIDER, GeminiProvider, gateway_from_environment, gemini_config
from backend.main import create_app
from backend.storage import InMemoryStore
from tests.test_ai_gateway import Clock, body, no_network, post  # noqa: F401  (autouse network guard)

TEXT = 'Essay deadline 2027-03-12.'


class FakeModels:
    def __init__(self, text, finish='STOP', usage=(900, 100, 20), error=None):
        self.text, self.finish, self.usage, self.error = text, finish, usage, error
        self.calls = []

    async def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        parts = [SimpleNamespace(text='thinking', thought=True), SimpleNamespace(text=self.text, thought=None)]
        return SimpleNamespace(
            usage_metadata=SimpleNamespace(prompt_token_count=self.usage[0], candidates_token_count=self.usage[1],
                                           thoughts_token_count=self.usage[2]),
            candidates=[SimpleNamespace(finish_reason=SimpleNamespace(name=self.finish), content=SimpleNamespace(parts=parts))])


def proposal_text():
    start = TEXT.index('2027-03-12')
    return json.dumps({'proposals': [{'title': 'Essay', 'type': 'assignment', 'date': {'value': '2027-03-12', 'precision': 'date'},
                                      'uncertain': False, 'evidence': [{'excerptId': 'ex-0', 'start': start, 'end': start + 10}]}]})


def make(tmp_path, models, **overrides):
    provider = GeminiProvider(client=SimpleNamespace(aio=SimpleNamespace(models=models)))
    gateway = AiGateway(gemini_config(str(tmp_path / 'ledger.sqlite3'), **overrides), provider, Clock())
    return TestClient(create_app(InMemoryStore(), ai_gateway=gateway)), gateway


def send(client, request_id='req-1'):
    return post(client, body(client, texts=(TEXT,), request_id=request_id, destination='gemini', policy='gemini-free-policy-1'))


def test_availability_names_provider_retention_and_real_cost(tmp_path):
    client, _ = make(tmp_path, FakeModels(proposal_text()))
    info = client.get('/api/ai/availability').json()
    assert info['provider'] == GEMINI_PROVIDER and info['mode'] == 'gemini' and info['destination'] == 'gemini'
    assert 'free' in info['retention'] and 'human reviewers' in info['retention'] and 'personal' in info['retention']
    assert info['limits']['monthlyCapUsd'] == 0 and info['limits']['simulatedCost'] is False


def test_valid_output_is_accepted_with_gateway_provenance_and_billed_usage(tmp_path):
    models = FakeModels(proposal_text())
    client, gateway = make(tmp_path, models)
    response = send(client)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['mode'] == 'gemini'
    assert data['proposals'][0]['evidence'][0]['locationId'] == 'loc-0' and data['proposals'][0]['confirmed'] is False
    # Free tier: tokens are recorded (thinking counts as output) but nothing is billed.
    assert data['usage'] == {'inputTokens': 900, 'outputTokens': 120, 'costUsd': 0.0, 'simulated': False}
    call = models.calls[0]
    assert call['model'] == GEMINI_MODEL == 'gemini-3.8-flash'
    assert call['config']['max_output_tokens'] == 2000 and call['config']['response_mime_type'] == 'application/json'
    # Only excerpt ids and text leave the machine: no digests, location ids, dataset or consent data.
    assert json.loads(call['contents']) == {'excerpts': [{'id': 'ex-0', 'text': TEXT}], 'context': {}}
    assert gateway.ledger.rows()[0][2] == 'ok'


@pytest.mark.parametrize('models, code', [
    (FakeModels('Sure! Here is the JSON'), 'invalid_output'),
    (FakeModels(proposal_text(), finish='MAX_TOKENS'), 'provider_failure'),
    (FakeModels(proposal_text(), finish='SAFETY'), 'provider_failure'),
    (FakeModels('', error=RuntimeError('boom sk-SECRET-MARKER')), 'provider_failure'),
])
def test_provider_defects_fail_closed_without_leaking(tmp_path, models, code):
    client, _ = make(tmp_path, models)
    response = send(client)
    assert code in response.json()['message'] and 'SECRET' not in response.text
    assert len(models.calls) == 1  # never retried


def test_rate_limit_stops_before_any_call(tmp_path):
    models = FakeModels(proposal_text())
    client, _ = make(tmp_path, models, per_minute=1)
    assert send(client).status_code == 200
    assert 'rate_limit' in send(client, request_id='req-2').json()['message']
    assert len(models.calls) == 1


def test_environment_selection_is_opt_in(tmp_path):
    assert not gateway_from_environment({}).enabled
    assert not gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'gemini'}).enabled  # no key
    with pytest.raises(ValueError):
        gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test'})
    gateway = gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test',
                                        'MOODLE_HELPER_AI_LEDGER_PATH': str(tmp_path / 'l.sqlite3')})
    try:
        assert gateway.enabled and gateway.config.monthly_cap_usd == 0.0 and isinstance(gateway.provider, GeminiProvider)
    finally:
        gateway.close()
