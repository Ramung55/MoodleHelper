# Issue 20: Sync all integration review

The original #20 AC1 requires the user action to schedule selected courses and
invoke supported collectors. The synthetic harness exercises a coordinator but
does not establish this installed user path. The current HTTP adapter calls
`POST /api/sync`, which simulates Snapshot status updates; the installed extension
supplies no scan source to its optional synthetic worker. QA's synthetic pass is
therefore not a pass for original AC1. Keep #20 open and report that distinction.
#21's UI scope does not remove #20's service integration requirement.

## Safe immediate behavior and contract

Retain the existing `POST /api/sync` 200 Snapshot response and simulation only
for the trusted startup-selected demo namespace. The user-facing demo action,
progress and success must be explicitly labeled demo. For a non-demo namespace
without a verified, operational live source and enforceable request authority,
`POST /api/sync` returns 503 with the existing closed `{message}` error shape and
the fixed message `Live course sync is unavailable until Moodle access is verified.`
It makes no Snapshot, queue or collection mutation and cannot report simulated
full coverage. Namespace and capability come from trusted backend state, never a
request parameter or client assertion. If safe distinction cannot be established,
fail closed. Document this additive 503 response in source OpenAPI before the
implementation and retain all other existing operations and Snapshot schemas.
The frontend handles the error visibly without a success toast or fabricated
progress. There is currently no verified source, so no live enqueue branch is
authorized by this clarification.

The explicit synthetic integration harness may call the already specified
`POST /api/scan/runs` with its idempotency key and receive the existing 200
`ScanRun`; it drives an injected synthetic worker and uses durable run readback
for honest pending/running/terminal status. No unchanged Snapshot is presented
as a completed scan. The harness is not a runtime switch, does not confer live
identity and is not proof that an installed ordinary worker can run live scans.

Verification must cover demo 200 response and unmistakable demo labels, non-demo
503 exact safe response with no writes or false success, existing API compatibility,
and synthetic selected-course queue/worker scheduling and durable pending
readback. Test frontend error handling and backend behavior. Do not add a
dependency. The eventual AC1 completion requires an installed user action wired
to the durable selected-course scan queue and an installed worker with a verified
source and supported collectors. #3/#4 evidence and the enforceable shared
request authority plus actual browser termination acknowledgement remain blockers
for safe live operation; the authority cannot be replaced by a lease or an
assumption that worker death stops browser requests. No live readiness or full
coverage is inferred from synthetic evidence.
