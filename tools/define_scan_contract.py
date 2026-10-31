"""Apply the reviewed issue 20 source contract; this does not enable scans."""
from copy import deepcopy
from pathlib import Path
import yaml

path = Path(__file__).resolve().parents[1] / 'openapi.yaml'
doc = yaml.safe_load(path.read_text(encoding='utf-8'))
schemas = doc['components']['schemas']
ref = lambda name: {'$ref': '#/components/schemas/' + name}
enum = lambda *values: {'type': 'string', 'enum': list(values)}
arr = lambda item, maximum: {'type': 'array', 'items': item, 'maxItems': maximum}
def obj(properties, optional=(), **extra):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties,
            'required': [name for name in properties if name not in optional], **extra}

qid = deepcopy(schemas['QueueStart']['properties']['idempotencyKey'])
count = {'type': 'integer', 'minimum': 0}
generation = {'type': 'integer', 'minimum': 1}
revision = {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}
reasons = enum('undiscovered', 'unsupported_page', 'collector_unavailable', 'access_error',
               'signed_out', 'forbidden', 'request_failed', 'limit_reached', 'invalid_context')
reason_list = {**arr(reasons, 9), 'uniqueItems': True}
collector = enum('assignment', 'calendar', 'material', 'quiz', 'submission')
outcome = enum('ok', 'partial', 'failed', 'unavailable', 'forbidden', 'signed_out', 'undiscovered')
page_type = enum('course', 'assignment', 'calendar', 'material', 'quiz', 'submission', 'unsupported')
coverage = enum('complete', 'partial', 'none')
scope = enum('visited_activity_only', 'supplied_pages_only', 'supplied_ranges_only', 'unknown')
page_url = {'type': 'string', 'minLength': 1, 'maxLength': 4096, 'format': 'uri',
            'description': 'Canonical whitelisted HTTPS SDU route, with only its allowed query keys; no credentials, fragments, traversal or noncanonical port.'}
instant = {'type': 'string', 'format': 'date-time'}
error = enum('signed_out', 'request_failed', 'invalid_context')
schemas['ScanStart'] = obj({'idempotencyKey': qid}, description=(
    'Resolve current selected courses and exact unique source mappings atomically. '
    'Replay returns the original selection; cross-kind key reuse or an active mock job conflicts. '
    'No caller-supplied URLs or namespace. Request size is limited to 1 MiB.'))
job_props = {k: deepcopy(v) for k, v in schemas['QueueJob']['properties'].items() if k not in ('result', 'errorCode')}
job_props['errorCode'] = error
schemas['ScanJob'] = obj(job_props, ['errorCode'])
run_props = deepcopy(schemas['QueueRun']['properties'])
run_props['jobs']['items'] = ref('ScanJob')
schemas['ScanRun'] = obj(run_props, ['nextCursor'])
schemas['ScanClaim'] = obj({'job': ref('ScanJob'), 'token': qid, 'generation': generation,
    'expiresAt': count, 'sourceCourseId': {'type': 'string', 'pattern': '^[1-9][0-9]{0,127}$'},
    'selectionRevision': revision})
schemas['ScanClaimResponse'] = obj({'unfinished': {'type': 'boolean'}, 'claim': ref('ScanClaim')}, ['claim'])

page_props = {'pageType': page_type, 'scope': scope, 'outcome': outcome, 'coverage': coverage,
              'reasons': reason_list, 'observedAt': instant, 'pageUrl': page_url, 'collector': collector,
              'result': {'oneOf': [ref(n.title() + 'RefreshResult') for n in ('assignment','calendar','material','quiz','submission')]}}
conditions = [
    {'if': {'properties': {'outcome': {'const': 'undiscovered'}}, 'required': ['outcome']},
     'then': {'not': {'required': ['observedAt']}}, 'else': {'required': ['observedAt']}},
    {'if': {'required': ['collector']}, 'then': {'required': ['result']}},
    {'if': {'required': ['result']}, 'then': {'required': ['collector'], 'properties': {'outcome': enum('ok','partial')}}},
    {'if': {'properties': {'outcome': enum('failed','unavailable','forbidden','signed_out','undiscovered')}, 'required': ['outcome']},
     'then': {'properties': {'coverage': enum('partial','none'), 'reasons': {'minItems': 1}}, 'not': {'required': ['result']}}},
    {'if': {'properties': {'pageType': {'const': 'unsupported'}}, 'required': ['pageType']},
     'then': {'properties': {'coverage': enum('partial','none'), 'reasons': {'contains': {'const': 'unsupported_page'}}}}},
    {'if': {'properties': {'outcome': {'const': 'failed'}}, 'required': ['outcome']},
     'then': {'properties': {'reasons': {'contains': enum('access_error','request_failed','invalid_context')}}}},
    {'if': {'properties': {'outcome': {'const': 'partial'}}, 'required': ['outcome']},
     'then': {'properties': {'coverage': enum('partial','none'), 'reasons': {'minItems': 1}}}},
    {'if': {'properties': {'coverage': {'const': 'complete'}}, 'required': ['coverage']},
     'then': {'required': ['collector','result','pageUrl']}},
]
for kind in ('assignment','calendar','material','quiz','submission'):
    conditions.append({'if': {'properties': {'collector': {'const': kind}}, 'required': ['collector']},
        'then': {'properties': {'result': ref(kind.title() + 'RefreshResult')}, 'required': ['pageUrl']}})
for state, reason in [('unavailable','collector_unavailable'), ('forbidden','forbidden'),
                      ('signed_out','signed_out'), ('undiscovered','undiscovered')]:
    conditions.append({'if': {'properties': {'outcome': {'const': state}}, 'required': ['outcome']},
        'then': {'properties': {'reasons': {'contains': {'const': reason}}}}})
page_description = ('Collector/result kind must match; assignment uses /mod/assign/view.php, calendar uses '
    '/calendar/view.php, material uses a supported course, resource, url or folder route, quiz uses '
    '/mod/quiz/view.php and submission uses /mod/assign/view.php. Page type, collector, scope, '
    'route, source identity and claimed course must agree under server domain validation. '
    'A checked page requires a valid observation time; undiscovered sections must omit it. '
    'Failed, unavailable, forbidden, signed-out, unsupported and undiscovered evidence carries '
    'the applicable fixed reason; accepted observations require ok or partial outcome. '
    'An empty or incomplete listing cannot establish complete coverage.')
schemas['ScanPageInput'] = obj(page_props, ['observedAt','pageUrl','collector','result'],
                               description=page_description, allOf=conditions)
record_props = {k: deepcopy(v) for k,v in page_props.items() if k != 'result'}
record_props['ordinal'] = {'type': 'integer', 'minimum': 0, 'maximum': 99}
record_conditions = [conditions[0], *conditions[3:7], *conditions[-4:]]
schemas['ScanPageRecord'] = obj(record_props, ['observedAt','pageUrl','collector'],
                                description=page_description, allOf=record_conditions)
finish_props = {'jobId': qid, 'generation': generation, 'token': qid, 'selectionRevision': revision,
                'outcome': enum('completed','failed'), 'pages': arr(ref('ScanPageInput'),100),
                'incompleteReasons': reason_list, 'errorCode': error}
schemas['ScanFinish'] = obj(finish_props, ['errorCode'], description=(
    'Atomically validate claim, live demand, synthetic context, selection and unique mapping; '
    'merge accepted source observations, store page coverage and finish. Stale or cancelled claims '
    'commit nothing. A completed job does not assert complete course coverage.'), allOf=[
        {'if': {'properties': {'outcome': {'const': 'failed'}}, 'required': ['outcome']},
         'then': {'required': ['errorCode']}, 'else': {'not': {'required': ['errorCode']}}}])
schemas['ScanPageList'] = obj({'pages': arr(ref('ScanPageRecord'),100), 'incompleteReasons': reason_list,
    'nextCursor': qid, 'signInGuidance': {'type': 'string', 'const': 'Sign in to SDU Moodle to continue.'},
    'signInUrl': {'type': 'string', 'const': 'https://moodle.sdu.edu.kz/login/index.php'}},
    ['nextCursor','signInGuidance','signInUrl'], description=(
        'Stable ordinal pagination. When any recorded or job-level reason is signed_out, '
        'both fixed sign-in fields are present; otherwise they are omitted. No DOM, secrets or exception text.'),
    allOf=[{'if': {'anyOf': [
               {'properties': {'incompleteReasons': {'contains': {'const': 'signed_out'}}}},
               {'properties': {'pages': {'contains': {'properties': {'outcome': {'const': 'signed_out'}}, 'required': ['outcome']}}}}]},
            'then': {'required': ['signInGuidance', 'signInUrl']},
            'else': {'not': {'anyOf': [{'required': ['signInGuidance']}, {'required': ['signInUrl']}]}}}])

queue = doc['paths']
def operation(source_path, source_method, operation_id, response, request=None, description=''):
    operation = deepcopy(queue[source_path][source_method])
    operation['operationId'] = operation_id
    operation['tags'] = ['Scan']
    operation['description'] = description
    operation['responses']['200']['content']['application/json']['schema'] = ref(response)
    if request:
        operation['requestBody']['content']['application/json']['schema'] = ref(request)
    return operation
queue['/api/scan/runs'] = {'post': operation('/api/queue/runs','post','startScanRun','ScanRun','ScanStart',
    'Start selected uniquely mapped courses; same-kind jobs share demand. A mixed-kind conflict aborts the entire start.')}
queue['/api/scan/runs/{runId}'] = {'get': operation('/api/queue/runs/{runId}','get','readScanRun','ScanRun',
    description='Stable job pagination; limit 1–100, default 100.')}
queue['/api/scan/runs/{runId}/cancel'] = {'post': operation('/api/queue/runs/{runId}/cancel','post','cancelScanRun','ScanRun',
    description='Remove this run’s demand only; shared jobs continue for other live runs.')}
queue['/api/scan/claim'] = {'post': operation('/api/queue/claim','post','claimScanJob','ScanClaimResponse','QueueClaimInput',
    'Claim scan-kind jobs only. A claim is not a request authority.')}
queue['/api/scan/renew'] = {'post': operation('/api/queue/renew','post','renewScanClaim','QueueRenewResponse','QueueClaimToken',
    'Renew only an unexpired scan claim with live demand.')}
queue['/api/scan/finish'] = {'post': operation('/api/queue/finish','post','finishScanClaim','ScanJob','ScanFinish',
    'Complete only a valid scan claim with the atomic merge and coverage transaction.')}
pages = operation('/api/queue/runs/{runId}','get','readScanJobPages','ScanPageList',
                  description='Read stable job page evidence and incomplete reasons; limit 1–100, default 100.')
pages['parameters'][0]['name'] = 'jobId'
queue['/api/scan/jobs/{jobId}/pages'] = {'get': pages}
doc['tags'] = [tag for tag in doc['tags'] if tag.get('name') != 'Scan'] + [{'name':'Scan'}]
path.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True), encoding='utf-8')
