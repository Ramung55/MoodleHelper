# Architecture and ownership

## Visited-page collection (#18)

`extension/src/page-refresh.ts` owns one production lifecycle coordinator. Its
read-only page-source, collector registry, repository and clock interfaces permit
labeled synthetic envelopes without creating a second algorithm. `content.ts`
installs initial/popstate/hashchange/MutationObserver lifecycle and disposal.
Ordinary runtime is disabled: it has neither trustworthy live response metadata
nor a verified signed-in identity. It does not fabricate HTTP 200 from a Document.

`collection-repository.ts` supplies the isolated runtime adapter and separately
installed internal worker. It accepts only exact SDU HTTPS top-frame extension
senders with browser document/tab identity, derives document keys internally,
serializes bounded per-document work, and fetches three fixed loopback routes.
The dashboard's existing 17-operation catalog and origin list remain unchanged.
No page message or HTTP body can turn on synthetic or verified mode.

`backend/collection.py` owns trusted context, bounded process tokens and domain
validation. Only the explicit test harness service-injects a synthetic provider
against isolated SQLite. Backend active tokens, process binding, current course
selection/mapping and document generation prevent late results from writing.
The existing repository `mutate` transaction merges typed source records, safe
reviews and page receipts together. Submission confirmation/staleness comes only
from the existing backend retention primitive. No course-wide sync state is set.
The additive optional `Snapshot.collection` survives existing Snapshot/backups;
deletion removes it and explicit restore/reset retain their replacement meaning.

See [the complete contract and harness](../page-refresh-contract.md). Actual SDU
identity/envelopes, quiz/submission classifiers and Chrome installation inspection
remain unverified under their existing issues. This introduces no fetch queue,
course traversal, document transfer or Moodle write.

This records the implemented local boundary after [#57](https://github.com/Ramung55/MoodleHelper/issues/57) and [#58 QA PASS](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397890196), and the explicitly proposed extension boundary for [#2](https://github.com/Ramung55/MoodleHelper/issues/2). See the [backend checkpoint](../milestone-1-checkpoint.md), [integration checkpoint](../milestone-2-checkpoint.md), [message catalog](messages.md), and [#50 toolchain decision](toolchain.md). Package paths, commands and dependency approvals come from #50 and AGENTS.md; this document approves no packages.

## Implemented local application

`frontend/` is the React dashboard. `frontend/src/services/index.ts` selects `HttpAdapter` by default, without fixture fallback. `http-adapter.ts` sends credential-free JSON to same-origin `/api`; `frontend/vite.config.ts` proxies that prefix to `http://127.0.0.1:8000`. The documented dashboard origin is `http://127.0.0.1:5173`. This development proxy avoids cross-origin browser requests; FastAPI has no configured CORS middleware. Production proxying is not implemented.

`backend/main.py` starts one `BackendService` and environment-configured SQLAlchemy `SQLiteStore` per lifespan. Routers bind all 16 operations in root `openapi.yaml`; schemas validate wire values and services apply operations. The repository validates complete Snapshots, uses explicit atomic SQLite transactions and returns independent values. Startup selects one trusted immutable namespace; each persistent lookup/update uses its primary key. Restart preserves data, including deliberately empty datasets. New demo namespaces alone seed samples; new configured Moodle namespaces start empty with default settings. `InMemoryStore` remains explicitly injectable. Use one localhost worker. See [storage operations and recovery](sqlite-storage.md).

The dashboard derives views, workload and alerts from that Snapshot (`frontend/src/lib/app-store.tsx` and `frontend/src/domain/`). It displays load/request errors and retains the last successful state when a request fails. Extension detection can change the explanatory connection message, but does not switch the adapter, enable collection, or prove a compatible extension. The API's connection response remains `demo` with `extensionDetected: false`.

The older extension-owned IndexedDB/Dexie proposal is superseded as the authoritative application-data design by the user-selected local backend, which now owns SQLite. The future extension may own collection caches and a pending-observation queue, but must hand validated observations to the backend rather than create a competing authoritative Snapshot. Repository source replay is implemented; transport acknowledgement, durable queues and collector handoff remain #9/#19. No extension/shared package is scaffolded; #7/#51 own that work.

## Proposed collection and document boundaries

The future Chrome extension collects from SDU Moodle (`https://moodle.sdu.edu.kz`) using the student's existing authenticated browser session. Access is read-only: no submissions, Moodle uploads, or changes to Moodle. Browser-granted host permission and live-site parsing are prerequisites, not current capabilities. The website receives only validated course, assessment, submission-observation and material metadata, provenance and operation outcomes. Moodle passwords, cookies and session tokens must never cross to the dashboard, backend, backups or AI.

Local PDF/DOCX workers are proposed under #24 and related extraction issues. The current import takes `{courseId,fileName}` only and creates explicitly mocked candidates; it neither receives bytes nor performs extraction/OCR. Future local content transfer needs an approved transport, limits, parser dependencies and worker ownership before implementation. Download currently returns `supported:false`; no bytes are downloaded.

AI is optional and consent-based. Settings `ai.enabled`/`consentGiven` alone send no document content; `/api/ai/availability` currently returns unavailable. #42 must decide provider, retention, content limits and explicit consent scope; #43 owns the gateway. Only the minimum student-approved document content needed for an agreed request may eventually cross to an AI endpoint. Moodle credentials, unrelated Snapshot data and automatic whole-course uploads are excluded. No external AI endpoint or content send is implemented.

## Identifiers, provenance and personal ownership

Current IDs are opaque strings, not account-qualified Moodle identities. `backend/sample_data.py` supplies course IDs such as `c-csc`, assessments `a1`, materials `m1`, document `d1` and candidate `k1`. `activityId` is optional. SourceEvidence has no separate ID: its fields are `source`, `date`, optional `excerpt`/`location`/`url`, and `observedAt`. Never describe a nonexistent source-ID algorithm as implemented.

Backend personal events use `p-` plus UUID hex; imports use `d-` plus UUID hex, with candidate `k-` plus that document ID. A confirmed unmatched candidate produces assessment `syl-` plus candidate ID; a matched one appends evidence to `matchAssessmentId`. IDs survive SQLite restart. Repeated HTTP review retains its current behavior; repository source upsert separately deduplicates identical source evidence using all present fields and stable namespace-local record ID. #5 identity helpers and #6 atomic upsert preserve overlays, without claiming cross-source matching (#33) or live identity discovery (#9/#3). Versioned migrations preserve the aggregate.

Assessment source facts and first/last observation timestamps remain separate from Overlay (`assessmentId`, personal title/date override, baseline, hidden, completed). Moodle `submission.status`, evidence and observed time are observations, not personal completion. Personal completion never submits or changes Moodle. DateValue preserves exact timestamp/timezone, calendar day, teaching week or unknown date without inventing precision. Source priority uses Moodle before syllabus before personal; a nonnull personal date override records the effective source baseline. #53/#58 implemented explicit JSON-null clearing; wider conflict/edit product behavior remains in #53.

## Deployment and isolation gate

Requests cannot choose a dataset: there is no request identity selector or authentication cookie. Trusted process configuration selects a canonical demo or Moodle origin/profile/stable-user namespace at startup. `security: []` remains credential-free; local clients reaching that process share its selected namespace. Bind to `127.0.0.1`; this is data partitioning, not authentication or permission for public student-data exposure. Switching identities means stop/configure/restart; incomplete configuration is rejected.

Real student-data deployment remains blocked under #6/#9 until Moodle identity mapping, profile separation, dataset selection, permission grants and credential-free collector handoff are agreed. Hosted deployment, trusted public origins, API authentication/authorization and production routing also require explicit decisions under #2/#6/#9; no cloud accounts or storage are implicitly introduced. The current extension allowlist does not secure HTTP, and the presence of a preview origin does not authorize hosting this backend publicly.

SQLAlchemy>=2,<3 was explicitly approved by the human on 2026-10-25 after the earlier deferral. #6 now implements SQLite persistence, restart, migration/rollback, storage errors and configured namespace partitioning; see its [checkpoint](../milestone-3-checkpoint.md). Independent QA PASS is required before closure or milestone-4 features. No documentation claim substitutes for that verdict.

## Contract gaps and owners

| Owner | Current fact | Missing input / gate |
| --- | --- | --- |
| #53 (coordinated #58 addition) | Omitted overlay keys retain values; explicit null clears optional title/date/baseline; date clear removes baseline; Snapshot emits no null overlay keys | Remaining conflict/edit UX and product criteria require their own implementation and QA |
| #24 | Filename-only JSON; mock extraction | Byte transport, size/MIME limits, local worker/parser/OCR ownership and dependency approval |
| #19/#21 | Sync/import HTTP returns final results; callbacks receive final Snapshots only | Progress events/jobs, ordering, cancellation request/acknowledgement and retained partial results |
| #6/#9/#19 | Backend authority chosen; extension cache/queue only proposed | Identity namespace, stable upsert, queue replay/merge, permission and observation handoff |
| #2/#6/#9 | Local development only; no HTTP auth | Hosted versus localhost trust policy, authenticated dataset selection and approved production origins |
| #42/#43 | AI unavailable; settings cause no send | Provider/policy/limits/consent and gateway contract |

These are explicit blockers or proposed decisions owned by the linked issue numbers, not claims that the corresponding feature is complete.

See the [complete shared model, strict ingestion boundary and identity inventory](data-model.md) for the #5 prerequisite to persistence.
