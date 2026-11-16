"""OpenTelemetry: off without an endpoint, and only method, route template and status leave the process."""
import json
import logging
import time

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from backend.main import create_app
from backend.storage import InMemoryStore
from backend.telemetry import TelemetryMiddleware

SECRET = 'sdu-course-4711-deadline-title'


def _middleware(app):
    return [m.cls for m in app.user_middleware]


def test_off_without_endpoint(monkeypatch):
    monkeypatch.delenv('OTEL_EXPORTER_OTLP_ENDPOINT', raising=False)
    monkeypatch.setenv('MOODLE_HELPER_ENVIRONMENT', 'dev')
    assert TelemetryMiddleware not in _middleware(create_app(InMemoryStore()))


@pytest.mark.parametrize('value', ['', 'production', 'Dev', 'staging'])
def test_invalid_environment_stops_startup(monkeypatch, value):
    monkeypatch.setenv('MOODLE_HELPER_ENVIRONMENT', value)
    with pytest.raises(ValueError, match='MOODLE_HELPER_ENVIRONMENT'):
        create_app(InMemoryStore())


def test_endpoint_requires_environment(monkeypatch):
    monkeypatch.delenv('MOODLE_HELPER_ENVIRONMENT', raising=False)
    monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318')
    with pytest.raises(ValueError, match='required when OTEL_EXPORTER_OTLP_ENDPOINT'):
        create_app(InMemoryStore())


@pytest.fixture
def telemetry(monkeypatch):
    monkeypatch.setenv('MOODLE_HELPER_ENVIRONMENT', 'prod')
    monkeypatch.setenv('MOODLE_HELPER_RELEASE', 'c' * 40)
    monkeypatch.setenv('OTEL_BSP_SCHEDULE_DELAY', '10')
    monkeypatch.setenv('OTEL_BLRP_SCHEDULE_DELAY', '10')
    spans, metrics, logs = InMemorySpanExporter(), InMemoryMetricReader(), InMemoryLogRecordExporter()
    app = create_app(InMemoryStore(), telemetry_exporters=(spans, metrics, logs))

    @app.get('/boom/{name}')
    def boom(name: str):
        raise RuntimeError(f'failed for {name}')

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, spans, metrics, logs
    logging.getLogger('moodle_helper').handlers.clear()


def _wait(get):
    for _ in range(200):
        if got := get():
            return got
        time.sleep(0.01)
    raise AssertionError('nothing exported')


def test_spans_use_route_templates_and_carry_nothing_private(telemetry):
    client, spans, metrics, _ = telemetry
    assert client.get(f'/api/queue/runs/{SECRET}?title={SECRET}', headers={'x-course': SECRET}).status_code < 600
    assert client.get(f'/boom/{SECRET}?q={SECRET}').status_code == 500
    assert client.get(f'/no-such-{SECRET}').status_code in (200, 404)  # SPA fallback or 404
    finished = _wait(lambda: spans.get_finished_spans() if len(spans.get_finished_spans()) >= 3 else None)
    names = {span.name for span in finished}
    assert 'GET /api/queue/runs/{runId}' in names and 'GET /boom/{name}' in names
    boom = next(span for span in finished if span.name == 'GET /boom/{name}')
    assert boom.status.status_code.name == 'ERROR' and boom.status.description is None and not boom.events
    for span in finished:
        assert set(span.attributes) <= {'http.request.method', 'http.route', 'http.response.status_code'}
        assert SECRET not in span.name + json.dumps(dict(span.attributes))
        assert {'service.name': 'moodlehelper-backend', 'service.version': 'c' * 40,
                'deployment.environment.name': 'prod'}.items() <= dict(span.resource.attributes).items()
    points = [point for rm in metrics.get_metrics_data().resource_metrics for sm in rm.scope_metrics
              for metric in sm.metrics if metric.name == 'http.server.request.duration' for point in metric.data.data_points]
    assert points and all(SECRET not in json.dumps(dict(point.attributes)) for point in points)
    assert {'http.request.method': 'GET', 'http.route': '/boom/{name}', 'http.response.status_code': 500} in [
        dict(point.attributes) for point in points]


def test_only_the_app_logger_is_exported(telemetry):
    _, _, _, logs = telemetry
    logging.getLogger('uvicorn.access').warning('GET /api/queue/runs/%s?title=%s', SECRET, SECRET)
    logging.getLogger('moodle_helper.ai_gateway').info('ai_extract ok request=%s proposals=%d', 'r-1', 2)
    exported = _wait(logs.get_finished_logs)
    bodies = [str(item.log_record.body) for item in exported]
    assert bodies == ['ai_extract ok request=r-1 proposals=2']
