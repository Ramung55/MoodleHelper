# Issue #8 engineering verification

2026-10-26. Canonical issue freshly read through the GitHub connector before
implementation. Core implementation checkpoint: `f288bd6`. Engineer handoff;
issue stays open and independent QA is required.

## Changes and scope

Preserved React/TanStack dashboard and all real route content/actions, including
Weekly planner and Alerts. Added explicit DEV-only shell previews outside the
normal provider; no fixture snapshot or persistent adapter is constructed.
Shared shell retains route headings, Main navigation, active link, loading/busy,
empty explanation and error alert/Retry. Simulated Retry updates the same URL
route to empty preview; Exit remounts normal HTTP. Root rechecks the build-time
gate because TanStack can retain unvalidated raw search keys. Normal startup
Retry repeats initialization and cancels stale completion through the existing
alive cleanup; success clears error. Default HttpAdapter is unchanged.

Native skip/main focus, route focus, toggle expanded/controls and current-link
semantics are implemented. Existing global focus-visible CSS is unchanged.
No new dependency, manifest, lockfile, backend, extension, storage or route-screen
change was required.

## Evidence-driven server configuration

Before changing configuration, `bun run build` succeeded with the inherited
Cloudflare preset. However the actual `bun run preview --host 127.0.0.1 --port
4173` request `/settings?shellState=error` returned HTTP 500:
`ERR_MODULE_NOT_FOUND ... frontend/dist/server/server.js`.
Nitro emitted `.output/server/index.mjs`, not the TanStack preview path.

Within the canonical permission for evidence-driven server configuration,
`vite.config.ts` selects existing Nitro `node-server` for a supported standalone
local production entry: `HOST=127.0.0.1 PORT=4174 node .output/server/index.mjs`
(use README's PowerShell syntax). No hosting provider or dependency was added.
The bundled Lovable config documents its own production preset override; it was
not changed. Vite dev `/api` proxy remains intact. The standalone production
server has no backend proxy configured; these checks do not prove production
API operation or public deployment. `bun run preview` remains an inherited
unsupported entry for this Nitro output; the documented Node entry is verified.

## Commands and observed results

Environment: Windows PowerShell, Node v24.20.0, Bun 1.3.13, installed Vitest
4.1.11 (the existing manifest range is unchanged). No dependency install was
needed. Backend port 8000 had no listener during route evidence collection.

| Command / scope | Observed result |
| --- | --- |
| `bun run test` in frontend | 101 passed in 6 files, exit 0 |
| `bun run build` in frontend | Client/SSR/Nitro Node build passed, exit 0 |
| `bun run dev --host 127.0.0.1 --port 5173` | Running real Vite/TanStack development server |
| `HOST=127.0.0.1 PORT=4174 node .output/server/index.mjs` | Running real built local production server |
| `node src/test/verify-shell-http.mjs http://127.0.0.1:5173 http://127.0.0.1:4174` | 100 direct/refresh HTML responses passed; unknown paths 404 on both; production client assets 200 |

Existing build warnings about tsconfig-paths and inlineDynamicImports remain.
Root Python/backend files and authoritative OpenAPI were unchanged; the full
frontend suite includes its existing actual FastAPI/temporary SQLite integration.

HTTP matrix: each of `/`, `/deadlines`, `/syllabus`, `/materials`, `/settings`
requested twice with no switch, loading, empty, error and invalid switch on each
server. Every response had HTTP 200, one correct h1 and one matching current
link. DEV valid states had requested placeholder and preview notice. Invalid
DEV and all production values had normal HTTP startup loading markup. Unknown
`/missing-shell-route` returned HTTP 404 with Page not found. Production module
entry scripts were served as JavaScript with HTTP 200. Repeated fresh HTTP GETs
establish direct/refresh server behavior, not actual browser reload/hydration.

Real-router DOM tests: 15 preview render cases assert services never initialize,
no fetch, localStorage reads/writes or window.postMessage occur, and no Settings
availability or automatic alert persistence occurs. All five error previews retry
to same-route empty. Three preview states navigate every required section while
retaining query. Five normal screens and planner/alerts render their original
content. Exit transitions into normal Settings and calls actual provider handlers.
Startup fails twice then recovers to actual Deadlines controls with errors cleared.
Fifteen production-mode query cases initialize the real provider and display its
real failure. Invalid/missing helper inputs and invalid-query real-provider case
are covered. Toggle/skip/current/focus assertions establish DOM behavior only.
Tests replace only the outer HTML document wrapper to avoid external stylesheet
loading in jsdom; actual root wiring, shell/provider and route components render.

## Explicit browser verification blocker

Prior supported Chrome inspection was stopped twice by URL-confidence policy,
including after human authorization and opening example.com. No additional UI
calls, alternate channel or policy bypass was attempted for #8. This is an
external inspection blocker, not evidence of dashboard failure or success.

Still missing: actual desktop Tab and Shift+Tab traversal, Enter activation of
links/toggle/Retry/skip, painted visible focus, selection and heading updates in
the running browser, narrow viewport navigation/layout and actual client
hydration/refresh. DOM focus calls and HTTP/asset responses do not establish these.
AC4's required manual browser evidence and AC3's browser hydration portion remain
unverified; do not mark all acceptance criteria PASS or close this issue.

When supported browser inspection is restored, use the README preview matrix
with backend stopped. On desktop and narrow viewport, traverse forward/backward,
activate links and Retry with Enter, confirm one correct heading/current link,
visible focus, skip-to-main focus and mobile toggle expansion/collapse. Refresh
each direct route and verify hydrated navigation. Exit preview with backend
stopped to observe actual error; start normal backend, Retry, and verify recovery.
Repeat normal direct routes on built local server while respecting its absent
API proxy boundary. Record browser version, viewport, URLs and observations.

Supplemental strict `bun x --no-install tsc --noEmit` was also inspected. It
still fails on existing errors in AssessmentRow/AssessmentSheet/domain/routes/
older tests. After correcting the new shell's optional fields, index-signature
access, and typed current-route navigation, no diagnostics named the changed
AppShell/app-store/root/preview utility/new shell test files. This is not a
claim that the repository-wide standalone typecheck passes. The resulting
same-route Retry behavior was rerun in all 49 shell tests, then the final build
and live HTTP checker were repeated against a restarted production server.
