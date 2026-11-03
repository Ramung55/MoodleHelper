# Issue #12 engineering verification

2026-10-26. Engineer handoff; issue remains open for independent QA.
Contract decision was committed before implementation in `c0d8834` and
`282067b`; implementation checkpoint is `fd74844`.

## Acceptance evidence

- AC1: `course-selection.test.tsx` renders full observed titles, every known
  term (including Russian text), unavailable facts, confirmed selection and
  explicit uncertainty. Legacy false is uncertain; legacy true remains a
  legacy suggestion.
- AC2/AC3: `http-live.test.ts` renders the actual Settings selection component
  inside AppProvider, saves through HttpAdapter/FastAPI to a temporary file
  SQLite database, ingests unchanged #11 parser output from labeled synthetic
  DOM, refreshes source facts and reopens after stopping/restarting FastAPI.
  It checks large string IDs, equal titles with distinct source IDs, replay,
  partial/empty ingest, new courses off, and preserved unrelated state.
- AC4: component and actual HTTP checks save/reopen an empty selection, show
  the explanation, and confirm sync leaves the empty whitelist intact.
- AC5: component checks cover pending disablement, confirmed values during
  failure, persistent selection-specific error/Retry, exact intended retry,
  reopen before retry and replacement by newer intent. Actual HTTP tests hold
  a real SQLite write lock, observe failed save/rollback, reopen confirmed
  values, release the lock and retry successfully through Settings.
- Contract/identity: model inventory exercises actual installed Zod, Python
  models and source YAML for known/unknown discriminator states, all current
  term statuses, Russian/multiple terms, large string IDs, invalid shapes and
  nonnullable metadata. Legacy snapshots retain permissive legacy fields.
  Backup checks preserve metadata. Backend tests reject whole invalid batches,
  conflicting mappings and deterministic identity collisions atomically;
  independent file-store writers preserve the latest whitelist and unrelated
  records while discovery and tracking saves interleave.

## Executed checks

- `uv run python -m pytest`: 364 passed (including 52 contract tests,
  29 discovery tests and 23 model-inventory tests).
- `npm test` in `frontend`: 250 passed across 9 files, including 5 selection
  component checks and 7 actual HTTP checks.
- `npm run build` in `frontend`: production client/server build passed.

Windows restricted process/temp-file access prevented the first ordinary test
launches before assertions. Both complete suites were rerun successfully with
normal process access; backend used the workspace `.uv-cache`. No dependencies
or lockfiles were changed. Existing FastAPI TestClient deprecation and Vite
tsconfig-path plugin notices remain non-failing.

No live Moodle completeness, selectors, identity or browser extension handoff
is claimed. Synthetic parser evidence is labeled; those capabilities remain
in their existing issues. Independent QA must verify every canonical criterion
before closure.
