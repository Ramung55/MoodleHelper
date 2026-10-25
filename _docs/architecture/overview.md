# Architecture and ownership

This records the implemented local boundary after [#57](https://github.com/Ramung55/MoodleHelper/issues/57) and [#58 QA PASS](https://github.com/Ramung55/MoodleHelper/issues/58#issuecomment-6397890196), and the explicitly proposed extension boundary for [#2](https://github.com/Ramung55/MoodleHelper/issues/2). See the [backend checkpoint](../milestone-1-checkpoint.md), [integration checkpoint](../milestone-2-checkpoint.md), [message catalog](messages.md), and [#50 toolchain decision](toolchain.md). Package paths, commands and dependency approvals come from #50 and AGENTS.md; this document approves no packages.

## Implemented local application

`frontend/` is the React dashboard. `frontend/src/services/index.ts` selects `HttpAdapter` by default, without fixture fallback. `http-adapter.ts` sends credential-free JSON to same-origin `/api`; `frontend/vite.config.ts` proxies that prefix to `http://127.0.0.1:8000`. The documented dashboard origin is `http://127.0.0.1:5173`. This development proxy avoids cross-origin browser requests; FastAPI has no configured CORS middleware. Production proxying is not implemented.

`backend/main.py` constructs one `BackendService` and `InMemoryStore` per application instance. `backend/routers.py` binds all 16 operations in root `openapi.yaml`; `backend/schemas.py` validates wire values; `backend/services.py` applies operations. The store validates a complete Snapshot, locks mutations, and returns deep copies. It contains a single shared fictional dataset, without login, account isolation, disk persistence or live Moodle access. Clients of the same instance see the same data. A new process starts fresh sample data; separate processes do not share state. Use one worker.

The dashboard derives views, workload and alerts from that Snapshot (`frontend/src/lib/app-store.tsx` and `frontend/src/domain/`). It displays load/request errors and retains the last successful state when a request fails. Extension detection can change the explanatory connection message, but does not switch the adapter, enable collection, or prove a compatible extension. The API's connection response remains `demo` with `extensionDetected: false`.

The older extension-owned IndexedDB/Dexie proposal is superseded as the authoritative application-data design by the user-selected local backend. The backend is authoritative now; a later approved SQLite database will belong to that backend. The future extension may own collection caches and a pending-observation queue, but must hand validated observations to the backend rather than create a competing authoritative Snapshot. Queue durability, acknowledgement, replay, merge and deletion rules remain unimplemented decisions under #6/#9/#19. No extension/shared package is scaffolded; #7/#51 own that work.

## Proposed collection and document boundaries

The future Chrome extension collects from SDU Moodle (`https://moodle.sdu.edu.kz`) using the student's existing authenticated browser session. Access is read-only: no submissions, Moodle uploads, or changes to Moodle. Browser-granted host permission and live-site parsing are prerequisites, not current capabilities. The website receives only validated course, assessment, submission-observation and material metadata, provenance and operation outcomes. Moodle passwords, cookies and session tokens must never cross to the dashboard, backend, backups or AI.

Local PDF/DOCX workers are proposed under #24 and related extraction issues. The current import takes `{courseId,fileName}` only and creates explicitly mocked candidates; it neither receives bytes nor performs extraction/OCR. Future local content transfer needs an approved transport, limits, parser dependencies and worker ownership before implementation. Download currently returns `supported:false`; no bytes are downloaded.

AI is optional and consent-based. Settings `ai.enabled`/`consentGiven` alone send no document content; `/api/ai/availability` currently returns unavailable. #42 must decide provider, retention, content limits and explicit consent scope; #43 owns the gateway. Only the minimum student-approved document content needed for an agreed request may eventually cross to an AI endpoint. Moodle credentials, unrelated Snapshot data and automatic whole-course uploads are excluded. No external AI endpoint or content send is implemented.

## Identifiers, provenance and personal ownership

Current IDs are opaque strings, not account-qualified Moodle identities. `backend/sample_data.py` supplies course IDs such as `c-csc`, assessments `a1`, materials `m1`, document `d1` and candidate `k1`. `activityId` is optional. SourceEvidence has no separate ID: its fields are `source`, `date`, optional `excerpt`/`location`/`url`, and `observedAt`. Never describe a nonexistent source-ID algorithm as implemented.

Backend personal events use `p-` plus UUID hex; imports use `d-` plus UUID hex, with candidate `k-` plus that document ID. A confirmed unmatched candidate produces assessment `syl-` plus candidate ID; a matched one appends evidence to `matchAssessmentId`. Existing IDs survive Snapshot round trips during a process lifetime. Repeated review is not guarded for idempotency. Stable Moodle identity/upsert, cross-source deduplication, migration and account namespaces remain #6 decisions; current generated IDs are not proof of those guarantees.

Assessment source facts and first/last observation timestamps remain separate from Overlay (`assessmentId`, personal title/date override, baseline, hidden, completed). Moodle `submission.status`, evidence and observed time are observations, not personal completion. Personal completion never submits or changes Moodle. DateValue preserves exact timestamp/timezone, calendar day, teaching week or unknown date without inventing precision. Source priority uses Moodle before syllabus before personal; a nonnull personal date override records the effective source baseline. #53/#58 implemented explicit JSON-null clearing; wider conflict/edit product behavior remains in #53.

## Deployment and isolation gate

Current requests identify no isolated dataset: there is no dataset selector, identity header, authentication cookie or account namespace. `security: []` means credential-free operation against the one local fictional dataset, not permission for public student-data exposure. Bind FastAPI to `127.0.0.1` using #50's startup command; localhost binding is an operational choice, not authentication. Local clients that can reach it are not isolated from one another.

Real student-data deployment remains blocked under #6/#9 until Moodle identity mapping, profile separation, dataset selection, permission grants and credential-free collector handoff are agreed. Hosted deployment, trusted public origins, API authentication/authorization and production routing also require explicit decisions under #2/#6/#9; no cloud accounts or storage are implicitly introduced. The current extension allowlist does not secure HTTP, and the presence of a preview origin does not authorize hosting this backend publicly.

SQLite/SQLAlchemy is the requested next milestone, but SQLAlchemy dependency approval is expressly deferred. #6 owns persistence, restart tests, migration/storage failure handling and isolated identities. There is no database implementation. Documentation PASS cannot satisfy that milestone or authorize milestone-4 feature work.

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
