# Integration catalog

Read with [ownership and trust boundaries](overview.md), [#50 toolchain](toolchain.md), and root [`openapi.yaml`](../../openapi.yaml). The source YAML still contains historical “proposed/no HTTP client” narrative and extension metadata; its method/path/schema bindings are now implemented by #57/#58. Current behavior is evidenced by `backend/{main,routers,schemas,services,storage}.py`, `frontend/src/services/{adapter,http-adapter,index,extension-adapter}.ts`, `frontend/src/lib/app-store.tsx`, the [backend checkpoint](../milestone-1-checkpoint.md), [integration checkpoint](../milestone-2-checkpoint.md), and [final #58 QA PASS](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397890196). This documentation does not alter the YAML.

## Current HTTP binding: all adapter operations

All paths below begin `/api`. JSON bodies are bare values shown, not message envelopes. No-body means no JSON payload. All successful responses are HTTP 200 with the final result, including inline domain failures. `Snapshot` always contains `courses, assessments, overlays, materials, documents, candidates, sync, changes, alerts, settings`. `kind` and `storage` are adapter metadata, not endpoints; HttpAdapter reports `kind:demo`, `storage:backend`. IDs are URI-component encoded by the client and accepted by backend path converters, including embedded slashes.

| Adapter / operationId | HTTP | Request body | Final response and backend action |
| --- | --- | --- | --- |
| connection | GET `/connection` | None | ConnectionInfo `{state,message,extensionDetected}`; fictional demo boundary |
| load | GET `/snapshot` | None | Snapshot from store |
| replaceAll | PUT `/snapshot` | Snapshot, **not** Backup `{app,version,exportedAt,note,data}` | Validated atomic replacement Snapshot; backup preview/version checks are frontend-local |
| setTrackedCourses | PUT `/tracked-courses` | String array, e.g. `["c-csc"]` | Snapshot; replaces settings.trackedCourseIds |
| updateOverlay | PATCH `/assessments/{assessmentId}/overlay` | OverlayPatch `{titleOverride?,dateOverride?,overrideBase?,hidden?,completed?}` | Snapshot; changes personal overlay, not source evidence |
| addPersonalEvent | POST `/personal-events` | `{courseId,title,type,date}` | Snapshot with generated personal assessment/source |
| deletePersonalEvent | DELETE `/personal-events/{id}` | None | Snapshot; removes matching personal assessment and overlay; missing ID is a no-op |
| syncAll | POST `/sync` | None | Snapshot; simulated per-course results, earlier assessment data retained |
| importDocument | POST `/documents/import` | `{courseId,fileName}` | `{snapshot,result:{ok:true}}` or `{snapshot,result:{ok:false,reason}}`; filename-only mock |
| review | POST `/candidates/{candidateId}/review` | `{kind:"confirm"}`, `{kind:"reject"}`, or `{kind:"correct",title,date,type}` | Snapshot; reject marks candidate; confirm/correct attaches syllabus evidence or creates assessment; missing ID is a no-op |
| downloadMaterial | POST `/materials/{id}/download` | None | `{snapshot,supported:false,message}`; unsupported even for accessible material; unknown/inaccessible material gets explanatory message |
| saveAlerts | PUT `/alerts` | Alert array | Snapshot; replaces alerts |
| updateSettings | PATCH `/settings` | Partial Settings | Snapshot; top-level merge, supplied nested settings objects replace their group |
| deleteLocalData | DELETE `/local-data` | None | Snapshot with all arrays emptied, settings retained except trackedCourseIds cleared |
| resetDemo (optional interface method, implemented) | POST `/demo/reset` | None | Fresh fictional sample Snapshot |
| aiAvailability | GET `/ai/availability` | None | `{available:false,reason}` now; schema also allows `{available:true,provider,retention}` for future capability |

Wire schema fields are defined in `backend/schemas.py` and YAML components. Course is `{id,code,name,color:1..6,current}`. Assessment requires `{id,courseId,title,type,sources,personal,firstObservedAt,lastObservedAt}` with optional activityId, availableFrom and submission; sources is nonempty. Types are assignment/quiz/exam/other. DateValue is `{kind:"exact",iso,tz}`, `{kind:"date",date:"YYYY-MM-DD"}`, `{kind:"week",week:1..30}`, or `{kind:"unknown",note?}`. Timestamp/timezone/URL strings are intentionally not universally format-validated.

Alert requires `{id,kind,message,deliveryKey,createdAt,read}` and optional assessmentId; kinds are deadline/busy_week/change/sync. Settings contains trackedCourseIds, semesterStart, semesterWeeks (1..30), timezone, weights `{exam,assignment,quiz,other}`, thresholds `{maxOutstanding,maxWeighted}`, reminders `{enabled,hoursBefore,busyWeek}`, and ai `{enabled,consentGiven}`. Imported documents, extraction candidates, materials, sync states and changes retain the complete root schema; callers must not substitute a partial entity for Snapshot.

Omission retains patch values. Only OverlayPatch titleOverride/dateOverride/overrideBase accept null to clear; HttpAdapter converts explicitly present undefined override keys to null. Clearing dateOverride clears its baseline; setting a date captures the effective source baseline. Clearing a date while supplying a nonnull baseline is rejected atomically. Optional fields elsewhere are omitted, not null. Responses strip absent optional null placeholders. Extra object properties are ignored, not universally rejected. No referential-integrity/nonempty-title requirement is invented.

## Current errors, origins, versions and timing

HTTP uses `Accept:application/json`, Content-Type for bodies, and `credentials:omit`; no Authorization header or Moodle session is sent. Development is same-origin through the Vite proxy. FastAPI configures no CORS allowlist or login. HTTP contract/API version is `0.1.0`; paths are not version-prefixed and there is no implemented compatibility negotiation or version header.

`backend/main.py` returns validation failures as 422 `{message:"Invalid request: ..."}`, framework errors such as unmatched routes as their status with `{message}`, and unexpected failures as 500 `{message:"Internal server error."}`. Missing entity IDs do not universally produce 404: overlay can create an orphan overlay, review/delete can be no-ops, and download returns a capability wrapper. Unsupported filename/import and per-course sync failure remain 200 outcomes. No implemented 401/403 permission scheme is claimed.

HttpAdapter rejects its Promise with the backend message for non-2xx JSON errors; otherwise it uses an HTTP-status fallback. Network failure gives a local-backend reachability message. Invalid JSON or a response failing Zod validation is rejected. It has no configured HTTP timeout, cancellation or retry/fallback. `syncAll(onProgress)` invokes its callback once after the final response; import invokes it once with final `snapshot`. Callbacks are in-process functions and are never serialized. There are no progress/job/SSE/websocket/polling endpoints.

## Current extension detection only

`extension-adapter.ts` permits exactly these origins for its ping/hello detection:

- `https://id-preview--5c234d24-d1b3-462b-ab27-270a5a21b713.lovable.app`
- `http://localhost:8080`

The documented `http://127.0.0.1:5173` HTTP development origin is not on that detection list; detection there returns false. That does not prevent backend use. At an approved origin the page posts `{source:"moodle-helper-web",type:"ping"}` to its own origin. The listener requires `event.source === window`; the parser checks exact approved origin and a hello object `{source:"moodle-helper-extension",type:"hello",version:string}`. The standalone parser itself does not check event.source. Version is any string: this is schema validation, **not compatible-version enforcement**. Missing/invalid/unapproved hello is ignored and resolves false after the default 800 ms timeout; unsupported page origin or server rendering resolves false immediately. There is no current structured missing-extension/permission/timeout message, request ID or data-capable bridge.

## Proposed #9 bridge catalog (not implemented)

The proposed bridge reuses only the 16 explicitly permitted operations in the HTTP table, with the same request fields and final response schemas. A request would be `{source:"moodle-helper-web",type:"request",version:"1",requestId,operation,payload}`; payload is the table's body, or `{}` for no-body methods. For methods with an ID, payload is `{id,body}` (assessmentId/candidateId retain their semantic identity), or `{id}` for no-body ID methods. A response would be `{source:"moodle-helper-extension",type:"response",version:"1",requestId,ok:true,result}` or `{...,ok:false,error:{code,message}}`. This is a proposed closed catalog, not an implemented forwarding service. No arbitrary URL/fetch, Moodle write, cookie/token read or unrestricted privileged operation is allowed. Any future observation-ingest operation needs its own reviewed #6/#9 schema; it is not an undocumented seventeenth current endpoint.

Proposed rejection rules: require same-window source, an explicitly approved dashboard origin, exact supported version, nonempty requestId, a catalog operation and schema-valid payload before privileged work. Reject unsupported versions as `UNSUPPORTED_VERSION`, invalid fields/operations as `VALIDATION`, unavailable extension as `MISSING_EXTENSION`, denied host grant as `PERMISSION_DENIED`, and elapsed operation deadline as `TIMEOUT`. These codes are proposed bridge errors, not current HTTP statuses. No fallback to a generic privileged URL is permitted. The two current detection origins are a compatibility inventory, not approval of production HTTP access. #9 must approve a final origin list and operation deadline values, correlation/deduplication and grant/handshake policy before implementing this versioned catalog; #6 must first settle dataset identity. It must not transfer Moodle session credentials.

## Concrete current HTTP examples

This full fictional Snapshot is a valid illustrative GET `/api/snapshot` result, including the course list, original evidence and separate personal overlay. It is not a new `/courses` route or a claim that fixed timestamps equal the dynamic sample generator.

```json
{
  "courses": [{"id":"c-csc","code":"CSS 215","name":"Data Structures","color":1,"current":true}],
  "assessments": [{"id":"a1","activityId":"7001","courseId":"c-csc","title":"Lab 5","type":"assignment","sources":[{"source":"moodle","date":{"kind":"date","date":"2026-10-28"},"excerpt":"Lab 5 due 28 October","location":"Assignment page","url":"https://moodle.sdu.edu.kz/mod/assign/view.php?id=7001","observedAt":"2026-10-25T12:00:00Z"}],"submission":{"status":"draft","evidence":"Draft, not submitted","observedAt":"2026-10-25T12:00:00Z"},"personal":false,"firstObservedAt":"2026-10-25T12:00:00Z","lastObservedAt":"2026-10-25T12:00:00Z"}],
  "overlays": [{"assessmentId":"a1","titleOverride":"Finish Lab 5","dateOverride":{"kind":"date","date":"2026-10-27"},"overrideBase":{"kind":"date","date":"2026-10-28"},"hidden":false,"completed":true}],
  "materials": [], "documents": [], "candidates": [], "sync": [], "changes": [], "alerts": [],
  "settings": {"trackedCourseIds":["c-csc"],"semesterStart":"2026-09-01","semesterWeeks":15,"timezone":"Asia/Almaty","weights":{"exam":3,"assignment":2,"quiz":1,"other":0},"thresholds":{"maxOutstanding":5,"maxWeighted":10},"reminders":{"enabled":true,"hoursBefore":48,"busyWeek":true},"ai":{"enabled":false,"consentGiven":false}}
}
```

PATCH `/api/assessments/a1/overlay` with the following valid clear returns 200 and a complete Snapshot; titleOverride, dateOverride and overrideBase disappear, while source evidence and completed remain:

```json
{"titleOverride":null,"dateOverride":null}
```

Rejected request to the same endpoint (no mutation):

```json
{"dateOverride":null,"overrideBase":{"kind":"week","week":8}}
```

Actual 422 message envelope:

```json
{"message":"Invalid request: body: Value error, Clearing dateOverride cannot set a nonnull overrideBase"}
```

POST `/api/sync` has no body. This complete illustrative 200 response demonstrates partial operation success: one tracked course succeeds, one fails, and its previous evidence is retained. The failing course's coverage and lastSuccessAt describe earlier observations, not a newly successful collection. The current service simulates this failure for c-phy and never contacts Moodle.

```json
{
  "courses":[{"id":"c-csc","code":"CSS 215","name":"Data Structures","color":1,"current":true},{"id":"c-phy","code":"PHY 201","name":"General Physics","color":3,"current":true}],
  "assessments":[{"id":"a3","courseId":"c-phy","title":"Problem set 4","type":"assignment","sources":[{"source":"moodle","date":{"kind":"date","date":"2026-10-28"},"excerpt":"Earlier retained observation","observedAt":"2026-10-24T12:00:00Z"}],"personal":false,"firstObservedAt":"2026-10-24T12:00:00Z","lastObservedAt":"2026-10-24T12:00:00Z"}],
  "overlays":[],"materials":[],"documents":[],"candidates":[],
  "sync":[{"courseId":"c-csc","status":"ok","coverage":"full","lastSuccessAt":"2026-10-25T12:00:00Z","progress":100},{"courseId":"c-phy","status":"failed","coverage":"partial","lastSuccessAt":"2026-10-24T12:00:00Z","error":"Simulated Moodle error for 2 of 9 activities. Earlier data kept.","progress":100}],
  "changes":[],"alerts":[],
  "settings":{"trackedCourseIds":["c-csc","c-phy"],"semesterStart":"2026-09-01","semesterWeeks":15,"timezone":"Asia/Almaty","weights":{"exam":3,"assignment":2,"quiz":1,"other":0},"thresholds":{"maxOutstanding":5,"maxWeighted":10},"reminders":{"enabled":true,"hoursBefore":48,"busyWeek":true},"ai":{"enabled":false,"consentGiven":false}}
}
```

All examples are JSON data contracts. None authorizes persistence, account isolation, document-byte upload, external AI, or a live extension. The [contract-gap checklist](overview.md#contract-gaps-and-owners) records the unresolved owners and required inputs.


## Course discovery command (#12 contract checkpoint)

POST /api/courses/discovery (ingestCourseDiscovery) accepts
{observations:RawCourseObservation[]} and returns 200 Snapshot; 422 validation/identity
conflict and 503 storage failures use existing {message:string}. No namespace, Course.id,
tracking, credentials or current flag in command. Empty batch is a no-op; partial batches
retain absent courses. ONE latest-Snapshot store.mutate prevents stale snapshot replacement.
Data-model.md defines raw facts, trusted identity, ownership and presentation rules.

Existing PUT /api/tracked-courses persists personal whitelist, including empty selection.
Discovery never changes choices. UI keeps confirmed checkboxes pending/on failure,
prevents overlapping saves and stale responses, retains actionable error and Retry for
intended selection; new intent replaces obsolete retry. Refresh/save reconciliation
cannot restore stale client choices. Production uses real HttpAdapter/SQLite, no fallback;
collector transport may remain explicitly mocked until #9. No fixture/discovery button.
