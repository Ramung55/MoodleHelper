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

### Unresolved pre-code gate and honest handoff

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
