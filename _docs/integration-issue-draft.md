# Milestone 2 integration issue

Prepared against clean commit `b53373d`, 2026-10-25. The current full-stack objective is recorded in the user-supplied goal attachment. All 55 open canonical issues (#2–#56) were searched; #2 explicitly excludes a frontend HTTP adapter, #9 owns extension messaging, and closed #57 owns backend behavior. None owns this integration. A focused nonduplicate follow-up is appropriate.

The first GitHub creation attempt was rejected because automatic review recognized only earlier backend-only authorization. The user subsequently explicitly selected “Authorize expanded scope” for frontend API integration, the documented override-clearing change, one nonduplicate integration issue and the remaining PM → Engineer → QA backlog. SQLAlchemy remains deferred.

Proposed title: Connect the existing frontend to the local FastAPI API

Created after explicit approval as [#58](https://github.com/Ramung55/MoodleHelper/issues/58). The reset decision is also recorded on #53 without removing its original acceptance criteria.

## Goal

After the independently passing milestone-1 backend checkpoint, make the existing React dashboard use actual HTTP calls to the running FastAPI backend. Preserve the design and working functionality; record a passing integration checkpoint before persistence begins.

## Acceptance criteria

- [ ] A typed HTTP adapter implements every one of the 16 operations in root `openapi.yaml`, using exact methods, paths, identifier encoding, bare versus wrapped request bodies, and response shapes. Default service selection uses HTTP rather than DemoAdapter/localStorage. API failures never silently fall back to fixtures.
- [ ] Existing layout, routes, filters, forms, state derivation and source/personal separation remain. Successful actions use the returned Snapshot; page reload reads server state. Connection wording distinguishes local fictional backend data from live Moodle/extension capabilities.
- [ ] Exact local startup commands and a same-origin `/api` development proxy are documented and tested. If CORS is needed instead, allow only explicit local frontend origins. No wildcard credentialed CORS, Moodle credentials, cookies, public deployment or invented login is introduced: the current contract has `security: []`.
- [ ] Non-2xx `{message}` responses, network errors and malformed successful payloads produce useful Error messages in existing load/action flows. Failed actions retain the last successful Snapshot; sync/import errors clear pending flags and cause no unhandled rejection. Progress callbacks receive only the final Snapshot, without invented intermediate progress.
- [ ] Settings and other action flows do not display success after AppProvider catches an error; use an explicit success result before showing confirmation. Download and AI failures are caught as well. Sidebar/storage wording truthfully describes the local backend boundary while preserving layout; it does not claim all data remains in the browser.
- [ ] Existing overlay reset remains functional through the explicit coordinated #53 wire decision below. Omission means unchanged; clearing never silently serializes away. Schema, backend service/models, adapter serialization, UI behavior and tests agree. Full #53 criteria remain independently required; this issue does not close #53 merely for a reset transport fix.
- [ ] Existing unsupported import/download wrappers and unavailable-AI outcomes remain truthful. Integration does not imply file-byte extraction, live sync, actual downloads or external AI.
- [ ] Automated adapter tests cover all 16 request/response mappings, escaped ids, errors, malformed responses and final callbacks using existing fetch/Zod/Vitest tooling. Live integration tests call an actual running FastAPI process, covering initial load, selection, personal create/complete/delete, settings, restore/delete/reset, import/review and failure preservation.
- [ ] Independent QA runs frontend tests and production build, backend tests, and live integration checks; verifies browser load and a real mutation; records commands/results and commits the milestone-2 checkpoint before SQLite/SQLAlchemy starts. Mocked fetch tests alone do not demonstrate integration.

## Out of scope

- Persistence is milestone 3, after this checkpoint. SQLAlchemy approval is deferred.
- Real extension/Moodle work remains #3/#7/#9–#22; document-content extraction remains #24–#31; optional external AI remains #42–#44.
- Incremental sync/import progress and cancellation require #19/#21 contracts. No unagreed transport is invented.

## Constraints

- Make focused service/store/configuration/test/documentation changes; preserve the existing frontend design and functionality.
- Use existing dependencies; ask before adding any. Preserve the authoritative API except the explicit justified reset addition coordinated with #53.
- Follow one-issue-at-a-time PM → Engineer → QA. Engineer commits and comments; QA validates without fixing; orchestrator closes only on PASS.

## Proposed coordinated #53 reset decision

The user explicitly authorized this necessary documented contract change; it is not implemented yet. The current UI uses explicitly present JavaScript `undefined` to clear overrides; JSON omits that value, causing reset to become a no-op over HTTP. Preserving working reset justifies an additive nullable PATCH representation.

- `OverlayPatch.titleOverride: null` clears the saved title override; `dateOverride: null` clears the date override and its `overrideBase`.
- Omitted PATCH fields remain unchanged. Nonnull fields retain current types and constraints. The Snapshot Overlay representation remains nonnullable: cleared optional keys are absent.
- A nonnull date override captures the latest effective source-date baseline under existing semantics. A null baseline is allowed only as a clear instruction, never persisted as null. Contradictory `dateOverride: null` plus a nonnull baseline is rejected atomically.
- The HTTP adapter translates explicitly present undefined override keys to the agreed null command; it does not change unrelated omitted fields.
- Update OpenAPI description and OverlayPatch only, Python request model/service, adapter typing/serialization and the existing reset action together. Test set → unrelated patch retains → clear restores latest source; verify no source evidence is changed, nulls never leak into Snapshot, and a failed reset leaves prior state intact.
- Before #53 can close, independently verify all its original criteria: original evidence display, resync conflict indication, hide/restore eligibility, latest-source reset, explicit wire round trip, invalid calendar-date field errors, and save-failure preservation. Current permissive timestamp/URL strings do not satisfy those broader product validations automatically.
