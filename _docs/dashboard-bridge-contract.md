# Dashboard bridge: #9 preimplementation grooming

2026-10-26. Canonical issue: [#9](https://github.com/Ramung55/MoodleHelper/issues/9).
PM read its original five acceptance criteria and zero comments. This is a
grooming artifact, not implementation, QA PASS, permission to install, or a claim
that Chrome accepted the current extension. Follow [process](process.md),
[PM instructions](team/pm.md), and [task template](task-template.md).

## Goal

Allow only an approved local dashboard to request permitted local data through
a versioned extension bridge, preserving the backend's authoritative SQLite
repository and all working HTTP application behavior. Resolve the historical
#2 extension-owned repository proposal explicitly before implementing transport.

## Acceptance criteria

The original five criteria remain required, with these checkable details:

- [ ] **Original AC1:** An allowed-origin dashboard receives the expected
  versioned response for **each** operation documented by #2. Exercise all 16
  catalog rows in `architecture/messages.md`, with the same request/response
  meaning, plus explicitly account for #12's subsequent `ingestCourseDiscovery`.
  Verify actual mutation/read results rather than successful empty replies.
  Retain truthful unsupported download, unavailable AI, mock filename extraction
  and simulated sync outcomes; a bridge must not relabel them live capabilities.
- [ ] **Original AC2:** Unsupported origin/window/frame/sender, operation,
  malformed request or response, incompatible version, denied permission and
  unknown/mismatched identity return no student data. Show a fixed rejection
  where a trusted reply channel exists; ignore untrusted messages. Verify unknown
  keys, URL/identity selector injection and stale/duplicate IDs.
- [ ] **Original AC3:** With extension absent, operation timeout, worker restart,
  extension reload or revoked grant, dashboard guidance distinguishes installation,
  retry/reload, permission and identity setup. Retain the last successful HTTP
  Snapshot; no silent fixture fallback or adapter switch. Old replies cannot
  overwrite new state. A hello alone never asserts collection availability.
- [ ] **Original AC4:** Requests cannot choose a URL, host, method, headers,
  credentials, namespace or backend target. Inspect handlers and exercise URL
  injection, encoded IDs, redirects and unknown operations; no privileged fetch
  is issued for rejected input.
- [ ] **Original AC5:** Supported Chrome network/message inspection of the
  real transport shows no Moodle cookies, passwords or session tokens delivered
  to the website. Include success and failure paths. Automated sentinel checks
  additionally reject raw HTML, headers, private exception text and extra DTO
  properties; those checks do not substitute for actual browser inspection.

## Out of scope

- Live identity/session discovery is [#3](https://github.com/Ramung55/MoodleHelper/issues/3)
  and [#10](https://github.com/Ramung55/MoodleHelper/issues/10). #9 still owns
  refusing data until trusted identity agrees with #6's immutable namespace.
- Repository persistence is [#6](https://github.com/Ramung55/MoodleHelper/issues/6),
  collector ingestion/round trips [#18](https://github.com/Ramung55/MoodleHelper/issues/18),
  durable job/queue lifecycle [#19](https://github.com/Ramung55/MoodleHelper/issues/19),
  full scan [#20](https://github.com/Ramung55/MoodleHelper/issues/20), real downloads
  [#41](https://github.com/Ramung55/MoodleHelper/issues/41), and AI gateway
  [#43](https://github.com/Ramung55/MoodleHelper/issues/43).
- Actual browser installation/smoke remains
  [#7](https://github.com/Ramung55/MoodleHelper/issues/7); dashboard browser
  verification remains [#8](https://github.com/Ramung55/MoodleHelper/issues/8).
  No original #9 acceptance criterion is transferred to those issues or waived.
- No cloud account, public backend, new authentication scheme, Moodle write,
  extra dependency, or browser-testing installation is authorized here.

## Constraints

### Ownership and complete operation reconciliation

The operative repository is backend SQLite, selected by trusted process startup;
`HttpAdapter` remains the dashboard default. Do not implement a second extension
CRUD store or replace the working adapter to satisfy obsolete proposal text.

The complete required catalog is `connection`, `load`, `replaceAll`,
`setTrackedCourses`, `updateOverlay`, `addPersonalEvent`, `deletePersonalEvent`,
`syncAll`, `importDocument`, `review`, `downloadMaterial`, `saveAlerts`,
`updateSettings`, `deleteLocalData`, `resetDemo`, `aiAvailability`. The #12 addition
is `ingestCourseDiscovery`. Its request is `{observations:RawCourseObservation[]}`
and response is Snapshot; no namespace, generated Course ID or tracking choice
may be supplied. The existing HTTP table defines every other body/result,
including nullable overlay clears and wrapped import/download results.

**Decision:** retain all these operations. A narrowed privileged-only catalog
would lose original AC1 without an explicit requirement change. A fixed backend
facade is the compatible candidate: a compile-time operation-to-method/path map
with component-encoded IDs, never a caller-selected target. No generic URL relay,
redirect follow, caller headers or session credentials. This candidate is NOT
approved for student-data deployment until the identity handoff below is settled.
Existing HTTP service semantics remain the authority; #9 does not implement jobs,
live scans, document bytes or AI by changing wrapper responses.

The raw #13/#15/#16/#17 parser observations are not current Snapshot entities.
Do not route them through this facade, truncate their evidence to fit existing
schemas, or invent ingest commands. #18 must coordinate models, OpenAPI, storage,
backup and ingestion first, including assignment dates, calendar occurrences,
submission facts, folder hierarchy and per-reference listing proof.

### Proposed local origins and discovery

For the implementation review, approve only `http://127.0.0.1:5173` and
`http://localhost:5173`. Remove old hello approval for `http://localhost:8080`
and the single Lovable preview origin: they are historical detection inventory,
not grants to current local student data. No wildcard preview origin is approved.

Prefer an isolated content-script relay on these exact dashboard origins and
internal `runtime.sendMessage`, rather than letting a page choose an arbitrary
extension ID. There is no external-message listener. Relay accepts same-window,
same-origin, top-frame messages only. Worker independently checks sender.id equals
its runtime ID, sender URL origin, tab URL origin and frameId===0. A page hello is
not extension authentication; an untrusted page can forge its own window messages.
Only the internal verified runtime sender may cause work. Origin approval trusts
scripts served from that local dashboard origin; it does not authenticate HTTP.

Chrome's current [match-pattern documentation](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)
documents optional explicit ports, with omitted ports matching all ports. Use
explicit ports where supported and retain exact runtime origin checks regardless;
test the built manifest in supported Chrome rather than claiming port restrictions
from static tests. The [messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
supports content-script internal messages; use callback `sendResponse` with literal
`true` for asynchronous handlers to avoid relying on gradual Promise-listener rollout.
These primary sources were checked on this grooming date.

### Proposed closed protocol and operational limits

Shared pure TypeScript DTOs belong in `shared/src/bridge.ts`, with no package
addition. Envelope request: `{source:"moodle-helper-web",type:"request",
version:"1",clientId,requestId,operation,payload}`. IDs are bounded 1..128 ASCII
letters/digits/hyphen strings generated independently for a page lifetime and
request. Envelopes and all nested payload/result schemas reject unknown keys.
Payloads follow the catalog; no-body is `{}`, IDs use `{id}` or `{id,body}`.
Response: `{source:"moodle-helper-extension",type:"response",version:"1",
clientId,requestId,ok:true,result}` or the same correlation fields with
`ok:false,error:{code,message}`. Use allowlisted fixed public error messages.

Handshake has a separate `hello` request with empty payload and a response with
protocol version, worker generation and explicit capability states. It contains
no student records or secrets. Use 800 ms handshake and 10,000 ms operation
deadlines, max 32 pending requests per page and 1 MiB serialized envelopes.
Reject oversize before forwarding; do not silently truncate Snapshot responses.
Bounded limits are proposed product values, not measured Chrome performance.

Response validation is operation-specific before website delivery and again in
the client. Match both IDs, version and expected operation context. Ignore late,
unsolicited and mismatched replies. Dedup key is trusted sender document +
clientId + requestId; retain in-flight/final results for 60 seconds, max 128 entries.
Same key with different normalized operation/payload returns `DUPLICATE_CONFLICT`.
Reject excess capacity rather than evicting active writes. No automatic mutation
retry after timeout/reload; worker-memory dedup cannot prove whether a backend
mutation committed across worker loss. Show outcome-unknown guidance and refresh
before user retry; durable cross-restart idempotency is #19, not a false #9 claim.

Public codes: `VALIDATION`, `UNSUPPORTED_VERSION`, `UNSUPPORTED_OPERATION`,
`PERMISSION_DENIED`, `IDENTITY_REQUIRED`, `IDENTITY_MISMATCH`, `BACKEND_UNAVAILABLE`,
`INVALID_RESPONSE`, `DUPLICATE_CONFLICT`, `BUSY`, `TOO_LARGE`, `TIMEOUT`;
client-only `MISSING_EXTENSION` and `RECONNECT_REQUIRED` distinguish local failures.
No caught browser/backend error text is copied into public messages.

### Historical gate (superseded by the operative amendment below)

**Status: not implementation-ready for the full bridge.** The current unauthenticated
API exposes one configured namespace but provides no trusted identity attestation
to an extension. A website-supplied profile/user/namespace cannot establish that
handoff. #3 has not verified actual SDU stable-user discovery. `security: []` is
not client authentication. Before any facade returns Moodle data, document an
executable, trusted local configuration/identity comparison and grant workflow,
including who configures the fixed backend endpoint, how the worker learns its
immutable namespace without caller selection, and how permission is revoked.
Do not invent JWT/cookie/account flows. Unknown identity must return a fixed
rejection, never demo data or another namespace. A demo-only test is not full AC1.

Moodle host permission must be requested only through explicit extension UI user
action, not website handshake. It gates collection and reports grant state; it
does not itself authorize repository data or establish identity. The candidate
backend host grant and trust mechanism remain part of the unresolved facade
decision. No host grant, manifest change or installation is performed by this doc.

Independently implementable after a focused engineer handoff: pure protocol
validators/correlation tests using labeled fixtures and callback mocks, with
all transport capabilities still honestly unavailable. That slice cannot close #9.
Supported computer-use Chrome state/URL inspection currently stops on confidence
checks, including after human browser/load approval and manual example.com.
No UI retry, bypass, alternate browser install or fabricated network trace is
authorized; actual Chrome portions of AC1/2/3/5 remain blocked.

After resolving the gate, exact intended files are `shared/src/bridge.ts`,
`extension/src/{index,content,dashboard-bridge}.ts`, `extension/manifest.json`,
`frontend/src/services/extension-adapter.ts`, focused Settings connection guidance
in `frontend/src/routes/settings.tsx`, and focused tests under `browser-workspace/`
and `frontend/src/test/`. Locate the actual Settings route before edits; do not
create a duplicate route. Any required backend attestation endpoint/DTO extends
this file boundary and needs its explicit preimplementation contract first.

Verification plan: shared/extension native Bun builds; focused existing Vitest
Node/jsdom tests for all operation requests/results, origin/sender failures,
identity/grants, version/schema rejection, private sentinel stripping/rejection,
correlation/dedup/capacity/timeouts/reload and UI retention/guidance; full frontend
tests/build and `uv run pytest` only after integration changes. Then independent
QA must inspect supported Chrome's built extension and real network/messages for
the five original criteria. No tests were run for this Markdown-only grooming.

### Operative amendment, 2026-10-26: engineer handoff READY

This amendment supersedes every conflicting identity gate, deployment caveat,
mandatory-manual-Chrome clause, and validator-only handoff above. It preserves
all five original AC and the complete 16-operation catalog plus #12 discovery.
It also supersedes the obsolete proposed identity gate in architecture/messages.md.

The accepted #6 trust model lets any local client reaching one backend process
share its startup-selected namespace. HttpAdapter already uses that model.
Local repository CRUD therefore needs no verified Moodle browser identity.
Live identity matching remains a prerequisite for future privileged collection
#3/#18/#20; no such collection is introduced by the local facade. Partitioning
is not authentication. No public deployment, JWT, account or new dependency.

Use exactly http://127.0.0.1:8000 as compiled backend target. Operator selects
dataset with existing startup environment, binds loopback and restarts to change
it. Worker reads an opaque process binding from that fixed backend; neither
page nor headers may select a namespace. No Moodle identity, profile, database
path or credentials are exposed in handshake.

Before implementation, amend source openapi.yaml with GET /api/bridge-context,
operationId bridgeContext: no parameters/body, 200 closed BridgeContext
{version:"1",binding:string}. Binding is a nonsecret UUID hex string created once
per app lifespan after immutable store selection, changes at restart and is not
persisted. Injected test apps initialize once before first use and replace at
lifespan entry, never per request. Preserve /connection and its current schema.

Document optional X-Moodle-Helper-Bridge-Binding header on all 17 catalog routes.
Absent preserves legacy HTTP clients. Present must exactly match current app
binding, checked before parsing/service work; mismatch returns 409 fixed
{message:"Backend context changed. Reconnect."}, no data or mutation. Document
reusable header and 409 in source OpenAPI, then mirror runtime/generated schema.
This precondition binds a process to its selected dataset; it authenticates
nobody and cannot select another dataset. No Snapshot revision scheme is added.

Hello fetches this fixed context with credentials omit and redirect error. Closed
hello result has protocol version, workerGeneration, fresh opaque sessionId,
backend ready|unavailable, localRepository ready|unavailable and moodleCollection
unavailable. Requests add sessionId to the envelope above. Worker keeps session
to backend-binding association and adds its own precondition header. Page cannot
supply that header/binding. On 409 invalidate sessions and return
RECONNECT_REQUIRED; never silently refresh context and replay pending mutations.
Worker loss rejects old sessions. Re-handshake is explicit. Unknown outcome after
mutation timeout/reload requires refresh before manual retry, never blind replay.
Backend failure yields BACKEND_UNAVAILABLE; missing/revoked local grant yields
PERMISSION_DENIED. IDENTITY_REQUIRED/MISMATCH are not used for local CRUD.

Manifest grants only dashboard matches http://127.0.0.1:5173/* and
http://localhost:5173/*, and backend host http://127.0.0.1:8000/*; old 8080 and
Lovable origins are retired for data access. Keep inert Moodle parser entry;
add no Moodle fetch, cookies, tabs, scripting, webRequest, storage or external
messaging permissions. Standard install/site-access controls grant/revoke local
access; website handshake never requests permission. Internal isolated relay
uses its own runtime.sendMessage: no page-selected extension ID or manifest key.
Worker independently checks runtime ID, sender URL, tab origin and top frame;
relay checks exact same-window/origin/top frame. Hello forgery can spoof page
status but cannot authorize privileged work. Keep exact runtime origin checks
regardless of manifest behavior. Current Chrome primary match-pattern docs
explicitly support optional ports; current messaging docs support callback with
literal true for asynchronous replies. Both linked sources were rechecked today.

Implement all catalog operations with fixed method/path and recursively closed
request/result schemas, including full Snapshot fields/unions and nullable overlay
clears. Reject dot-segment-only IDs . and .. before URL construction; encode
opaque IDs and test slash/query/hash inputs cannot alter target or route. Reject
caller URL/method/header/namespace/unknown keys before fetch; reject redirects.
No generic fetch, duplicate extension repository, fallback fixtures or adapter
replacement. Schema checks cannot recognize secrets deliberately inserted in
allowed free-text fields: privacy proof concerns transport never acquiring or
forwarding credentials, headers, raw HTML responses or private exception text.

Exact files: openapi.yaml; backend/main.py, routers.py, schemas.py;
shared/src/index.ts and bridge.ts; extension/src/index.ts, content.ts,
dashboard-bridge.ts; extension/manifest.json and build.ts if a separate dashboard
relay bundle is needed; frontend/src/services/extension-adapter.ts. Reuse complete
frontend/src/domain/types.ts inventory without adding dependencies. Add callable
typed BridgeClient for all 17 operations while services/index.ts retains default
HttpAdapter. Focus guidance edits in existing frontend/src/routes/settings.tsx
and lib/app-store.tsx only as needed. Missing extension must leave working HTTP
app and last successful Snapshot usable. Callbacks remain local final-result
notifications, never serialized.

Verification uses existing Bun builds, Vitest tests in browser-workspace/ and
frontend/src/test/, frontend full tests/build and uv run pytest after integration.
Drive production client/relay/worker through a clearly labeled Chrome API/window
shim and real loopback FastAPI network with isolated SQLite. Inspect actual
HTTP methods/paths/headers/bodies and both success/failure message envelopes;
verify real mutation/read results for all 17 operations, binding restart races,
409 before mutation and legacy HTTP compatibility. Exercise every rejection,
origin/frame/sender, version, nested unknown key, redirect, encoded ID, private
exception/cookie/header sentinel, dedup conflict/capacity, correlation, deadline,
reload/revocation and unknown mutation outcome. No raw errors reach page.

Original #9 expressly permits mocks and requires network/message inspection,
but does not mandate manual Chrome. Production transport driven through a shim
with real backend traffic can provide the original five AC evidence; label the
shim precisely and do not claim installed Chrome was observed. Actual Chrome
smoke/URL evidence remains #7/#8 and their current confidence-check blockage is
not a pre-code block. Do not retry/bypass protected UI. Independent QA must
identify any remaining runtime-specific evidence accurately, without dropping
operations or silently waiving an original AC. No code, tests, grants or install
were performed by this documentation grooming.

### Chrome sender metadata clarification (operative, 2026-10-26)

This replaces the mandatory tab URL check above; it adds no permissions and
preserves all original AC and all 17 operations. Chrome documents `tabs.Tab.url`
as permission-sensitive, so content_scripts.matches is not a guarantee it exists.
Use browser-supplied MessageSender fields, never payload copies: require
sender.id === chrome.runtime.id, sender.frameId === 0, sender.tab with a
nonnegative integer tab.id, and a parseable sender.url whose exact origin is one
of the two approved dashboard origins. Reject missing URL, opaque/non-HTTP URL,
userinfo, or unsupported origin. If sender.origin is present, require that it
exactly equals the parsed approved origin; reject opaque or conflicting values.
If sender.tab.url is present, parse and require the same approved origin as
sender.url; absence alone is valid. Do not fetch tab metadata or add tabs,
activeTab, webNavigation, or dashboard host grants merely to populate this field.
Top-frame sender.url is authoritative for this content-script request. Relay
continues checking event.source/window/origin and top-level window independently.

MessageSender.documentId is optional and documented from Chrome 106 onward.
For this bridge, require a nonempty browser-supplied documentId on hello and
operations; declare minimum_chrome_version 106 in the manifest. Missing documentId
fails closed with fixed RECONNECT_REQUIRED guidance to update/reload Chrome; no
student data or fetch follows. Minimum version does not prove the field exists:
the runtime check remains required. Never substitute a page-supplied document ID
or use only tab.id/frameId across navigation. Bind sessions and dedup ownership
to tuple (sender.tab.id, sender.frameId, sender.documentId), plus clientId and
requestId for dedup. Require exact owner on every operation before backend work.
A new document must handshake for its own session; an old document's session
cannot authorize the replacement document. Preserve 60-second bounded dedup and
unknown-mutation-outcome handling; no durable replay guarantee is implied.

Add focused checks for absent tab.url accepted, present conflicting tab.url
rejected, absent/conflicting origin behavior, missing sender.url/documentId
rejected, and same tab/frame with different documentId unable to reuse session
or dedup records. These are planned tests, not Chrome observation.

Primary documentation verified on this date:
[MessageSender](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender)
and [Tab / permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab).

### Engineering checkpoint, 2026-10-27 (#9; independent QA still required)

Implemented the complete 17-operation local repository facade, source OpenAPI
context/precondition, typed `BridgeClient`/`ExtensionAdapter`, isolated relay and
internal callback worker. `services/index.ts` still selects `HttpAdapter`.
Use the optional client by constructing it, explicitly awaiting `connect()`, then
calling its typed methods; call `dispose()` when its owner unmounts. Sync/import
callbacks receive only the final validated Snapshot locally.

Sessions have a 60-second idle lease and maximum 128 entries. Idle sessions can
be reclaimed after page navigation, client disposal or repeated Settings checks;
in-flight work prevents lease reclamation. Expired clients receive
RECONNECT_REQUIRED and must explicitly reconnect. Worker independently enforces
32 in-flight requests per page/client, in addition to the client's pending limit.
Dedup retains in-flight records and settled results for 60 seconds, max128,
rejecting excess capacity and conflicting reuse. Neither lease expiry nor
reconnection automatically repeats a mutation. This is bounded worker memory,
not durable idempotency. Settings gives install/site-access/backend/reconnect
and unknown-write-outcome guidance without changing the HTTP Snapshot.

Verification at this checkpoint:

- `uv run pytest -q`: **450 passed**, existing Starlette/httpx deprecation warning.
- `bun run --cwd frontend test`: **629 passed**.
- `node frontend/node_modules/vitest/vitest.mjs run --config browser-workspace/vitest.config.mjs`:
  **53 passed**. This suite uses explicitly labeled window/Chrome API shims,
  production client/relay/worker code, and real loopback FastAPI with isolated
  file-backed SQLite. Test-only ASGI middleware supplies hostile responses and
  sentinel headers; it is never imported by the production backend entry point.
- Shared and extension Bun builds, frontend production build, and focused strict
  TypeScript compilation of worker/protocol pass. Project-wide strict `tsc`
  still reports pre-existing collector/domain/test errors; the bridge changes
  have no diagnostics in the targeted compilation. No dependency was added.

Network tests verify real results for all17 operations, explicit nullable clears,
methods/paths/precondition headers, legacy HTTP compatibility, restart409 before
mutation, and switching trusted startup partitions (demo and configured Moodle)
without page-selected identity. They inspect actual redirect/error/HTML/extra-key
responses with cookie/password/token sentinels, reject redirect following, and
exercise slash/query/hash/encoded-dot opaque IDs against the real API. No request
acquires Moodle cookies, credentials or HTML. Operation-specific recursive DTO
validation rejects extra fields before website delivery and again in the client.
A source-versus-shared inventory test detects drift in every operation/schema.

Focused tests additionally cover sender URL/origin/optional tab.url/runtime/top
frame/document ownership, new-document session/dedup denial, schema/version/URL
injection, oversize, permissions/revocation, worker loss, correlation, late
responses, capacity, in-flight dedup/conflicts, idle lease reclamation and deadlines.
The existing UI error/retention suite remains green alongside new Settings
guidance tests. These are automated shim/network observations, not evidence that
an installed Chrome extension or live SDU collection was inspected. Protected UI
was not retried or bypassed; #7/#8 retain their separately recorded runtime smoke
limitations. No remote push, grant, installation or issue closure is performed.
