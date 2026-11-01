"""#44 Claude Haiku 5.5 provider behind the Provider protocol. A fake SDK client keeps these tests offline."""

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.ai_gateway import (ANTHROPIC_MODEL, ANTHROPIC_PROVIDER, AiGateway, AnthropicProvider, anthropic_config,
                                gateway_from_environment)
from backend.main import create_app
from backend.storage import InMemoryStore
from tests.test_ai_gateway import Clock, body, no_network, post  # noqa: F401  (autouse network guard)

TEXT = 'Essay deadline 2027-03-12.'


class FakeMessages:
    def __init__(self, text, stop_reason='end_turn', usage=(900, 120), error=None):
        self.text, self.stop_reason, self.usage, self.error = text, stop_reason, usage, error
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(stop_reason=self.stop_reason,
                               usage=SimpleNamespace(input_tokens=self.usage[0], output_tokens=self.usage[1]),
                               content=[SimpleNamespace(type='thinking', thinking=''), SimpleNamespace(type='text', text=self.text)])


def proposal_text():
    start = TEXT.index('2027-03-12')
    return json.dumps({'proposals': [{'title': 'Essay', 'type': 'assignment', 'date': {'value': '2027-03-12', 'precision': 'date'},
                                      'uncertain': False, 'evidence': [{'excerptId': 'ex-0', 'start': start, 'end': start + 10}]}]})


def make(tmp_path, messages, **overrides):
    provider = AnthropicProvider(client=SimpleNamespace(messages=messages))
    gateway = AiGateway(anthropic_config(str(tmp_path / 'ledger.sqlite3'), **overrides), provider, Clock())
    return TestClient(create_app(InMemoryStore(), ai_gateway=gateway)), gateway


def send(client, **kw):
    return post(client, body(client, texts=(TEXT,), destination='anthropic', policy='anthropic-policy-1', **kw))


def test_availability_names_provider_retention_and_real_cost(tmp_path):
    client, _ = make(tmp_path, FakeMessages(proposal_text()))
    info = client.get('/api/ai/availability').json()
    assert info['provider'] == ANTHROPIC_PROVIDER and info['mode'] == 'anthropic' and info['destination'] == 'anthropic'
    assert 'Anthropic' in info['retention'] and info['limits']['simulatedCost'] is False


def test_valid_output_is_accepted_with_gateway_provenance_and_billed_usage(tmp_path):
    messages = FakeMessages(proposal_text())
    client, gateway = make(tmp_path, messages)
    response = send(client)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['mode'] == 'anthropic'
    assert data['proposals'][0]['evidence'][0]['locationId'] == 'loc-0' and data['proposals'][0]['confirmed'] is False
    assert data['usage'] == {'inputTokens': 900, 'outputTokens': 120, 'costUsd': 0.00015, 'simulated': False}
    call = messages.calls[0]
    assert call['model'] == ANTHROPIC_MODEL == 'claude-haiku-5-5' and call['max_tokens'] == 2000
    sent = json.loads(call['messages'][0]['content'])
    # Only excerpt ids and text leave the machine: no digests, location ids, dataset or consent data.
    assert sent == {'excerpts': [{'id': 'ex-0', 'text': TEXT}], 'context': {}}
    assert gateway.ledger.rows()[0][2] == 'ok'


@pytest.mark.parametrize('messages, code', [
    (FakeMessages('Sure! Here is the JSON'), 'invalid_output'),
    (FakeMessages(proposal_text(), stop_reason='max_tokens'), 'provider_failure'),
    (FakeMessages(proposal_text(), stop_reason='refusal'), 'provider_failure'),
    (FakeMessages('', error=RuntimeError('boom sk-SECRET-MARKER')), 'provider_failure'),
])
def test_provider_defects_fail_closed_without_leaking(tmp_path, messages, code):
    client, _ = make(tmp_path, messages)
    response = send(client)
    assert code in response.json()['message'] and 'SECRET' not in response.text
    assert len(messages.calls) == 1  # never retried


def test_monthly_cap_stops_before_any_call(tmp_path):
    messages = FakeMessages(proposal_text())
    client, _ = make(tmp_path, messages, monthly_cap_usd=0.0)
    assert 'budget_exhausted' in send(client).json()['message']
    assert messages.calls == []


def test_environment_selection_is_opt_in(tmp_path):
    assert not gateway_from_environment({}).enabled
    assert not gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'anthropic'}).enabled  # no key
    with pytest.raises(ValueError):
        gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'anthropic', 'ANTHROPIC_API_KEY': 'test'})
    gateway = gateway_from_environment({'MOODLE_HELPER_AI_PROVIDER': 'anthropic', 'ANTHROPIC_API_KEY': 'test',
                                        'MOODLE_HELPER_AI_LEDGER_PATH': str(tmp_path / 'l.sqlite3'),
                                        'MOODLE_HELPER_AI_MONTHLY_CAP_USD': '2'})
    try:
        assert gateway.enabled and gateway.config.monthly_cap_usd == 2.0 and isinstance(gateway.provider, AnthropicProvider)
    finally:
        gateway.close()
