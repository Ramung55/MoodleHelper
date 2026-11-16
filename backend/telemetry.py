"""OpenTelemetry traces, metrics and logs over OTLP/HTTP. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.

Privacy: requests are described only by method, route template (never the raw path or query) and status.
No headers, bodies, client addresses or exception messages are recorded; there is no auto-instrumentation,
so outgoing Moodle or Groq calls and SQL are not traced. Logs: only the `moodle_helper` logger is exported,
never root or uvicorn's access log (which prints raw paths and query strings).
"""
import logging
import time
from typing import NamedTuple

ENVIRONMENTS = ('dev', 'prod')
METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'}


def environment(env) -> str | None:
    value = env.get('MOODLE_HELPER_ENVIRONMENT')
    if value is not None and value not in ENVIRONMENTS:
        raise ValueError('MOODLE_HELPER_ENVIRONMENT must be dev or prod.')
    if value is None and env.get('OTEL_EXPORTER_OTLP_ENDPOINT'):
        raise ValueError('MOODLE_HELPER_ENVIRONMENT (dev or prod) is required when OTEL_EXPORTER_OTLP_ENDPOINT is set.')
    return value


class Telemetry(NamedTuple):
    tracer: object
    duration: object
    sync_runs_started: object
    personal_events_created: object
    personal_event_failures: object


def setup(env, exporters=None, active_sync_runs=None) -> Telemetry | None:
    """Returns None (telemetry off) without an endpoint. `exporters` = (span, metric_reader, log) for tests only.
    `active_sync_runs` is called at each metric export and returns the current count."""
    deployment = environment(env)
    if not env.get('OTEL_EXPORTER_OTLP_ENDPOINT') and exporters is None:
        return None
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    if exporters is None:
        # The exporters read the endpoint and OTEL_EXPORTER_OTLP_HEADERS (backend token) themselves.
        from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        exporters = (OTLPSpanExporter(), PeriodicExportingMetricReader(OTLPMetricExporter()), OTLPLogExporter())
    span_exporter, metric_reader, log_exporter = exporters
    resource = Resource.create({'service.name': 'moodlehelper-backend',
                                'service.version': env.get('MOODLE_HELPER_RELEASE', 'local'),
                                'deployment.environment.name': deployment})
    # Batch processors everywhere: bounded queues, background export, nothing per request on the 1 GB VM.
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))
    meter_provider = MeterProvider(resource=resource, metric_readers=[metric_reader])
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

    app_logger = logging.getLogger('moodle_helper')
    for handler in [h for h in app_logger.handlers if isinstance(h, LoggingHandler)]:
        app_logger.removeHandler(handler)  # create_app can run more than once per process (tests)
    # shortcut: the SDK's LoggingHandler is deprecated in favour of opentelemetry-instrumentation-logging;
    # switch when it is removed or that package is approved.
    app_logger.addHandler(LoggingHandler(level=logging.INFO, logger_provider=logger_provider))
    app_logger.setLevel(logging.INFO)  # root's last-resort stderr handler still prints only WARNING and up

    meter = meter_provider.get_meter('moodlehelper-backend')
    from opentelemetry.metrics import Observation

    def observe_active(_options):
        try:
            return [Observation(active_sync_runs())] if active_sync_runs else []
        except Exception:  # storage unavailable (e.g. in-memory store): skip this sample, never break export
            return []

    meter.create_observable_up_down_counter('moodlehelper.sync.runs.active', [observe_active], unit='{run}',
                                            description='Moodle sync runs with a pending or running job.')
    return Telemetry(tracer_provider.get_tracer('moodlehelper-backend'),
                     meter.create_histogram('http.server.request.duration', unit='s',
                                            description='Duration of HTTP server requests.'),
                     meter.create_counter('moodlehelper.sync.runs.started', unit='{run}',
                                          description='Moodle sync runs started (new runs only, not replays).'),
                     meter.create_counter('moodlehelper.personal_events.created', unit='{event}',
                                          description='Personal events created.'),
                     meter.create_counter('moodlehelper.personal_events.failures', unit='{event}',
                                          description='Personal event creations that raised; error.type is the exception class.'))


class TelemetryMiddleware:
    """One server span and one duration sample per HTTP request, labelled by method, route template and status."""

    def __init__(self, app, telemetry: Telemetry):
        self.app = app
        self.telemetry = telemetry

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        from opentelemetry.trace import SpanKind, Status, StatusCode
        method = scope['method'] if scope['method'] in METHODS else '_OTHER'
        status = 500

        async def send_status(message):
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
            await send(message)

        start = time.perf_counter()
        # No record_exception / status description: exception messages may hold private data.
        with self.telemetry.tracer.start_as_current_span(method, kind=SpanKind.SERVER, record_exception=False,
                                                         set_status_on_exception=False) as span:
            try:
                await self.app(scope, receive, send_status)
            finally:
                attributes = {'http.request.method': method, 'http.response.status_code': status}
                # Starlette sets scope['route'] after matching; its .path is the template, e.g. /api/courses/{id}.
                route = getattr(scope.get('route'), 'path', None)
                if route:
                    attributes['http.route'] = route
                    span.update_name(f'{method} {route}')
                span.set_attributes(attributes)
                if status >= 500:
                    span.set_status(Status(StatusCode.ERROR))
                self.telemetry.duration.record(time.perf_counter() - start, attributes)
