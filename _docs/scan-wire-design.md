# Scan queue wire and storage design (issue 20, draft)

This draft records engineering decisions before scan wire code. It does not enable
or claim a finished scan. The existing mock queue remains independent and retains
its current endpoints and semantics. Scan and mock jobs must never claim each
other's work: migration 5 adds a non-null job `kind` defaulting to `mock` and
retains the existing unique active `(namespace, course_id)` index. All existing
queue claim queries are explicitly restricted to `mock`; scan claims select
only `scan` jobs. A start encountering an active job of the other kind rejects
the entire transaction with 409, with no run, job or link created. Same-kind
overlapping starts still share jobs. Simultaneous mixed-kind starts serialize at
the database write lock, so only one kind can create active work for a course.
Runs carry a kind; a key previously used by either kind cannot be reused for
the other and returns 409. Scan operations use `scan` jobs and the same
run/job/link/claim transaction discipline. Migration keeps every existing ID,
claim, link, result and snapshot intact. Each scan job records its source course
ID and selection revision at claim; commit rechecks the selected, unique mapping
and current injected synthetic context under the same database write lock.

The scan start request contains only `idempotencyKey` (the queue's bounded opaque
ID); the server takes the current tracked-course selection and rejects empty,
unmapped or ambiguous selections. Replaying a key returns the original immutable
selection; callers never supply URLs or a namespace. Claim and renewal use the
queue's existing bounded claim token shapes but operate only on scan jobs. Finish
contains that claim token, the selection revision, an outcome and at most 100
per-page entries. Each entry includes a canonical supported page URL (maximum
4096 characters), observed timestamp, collector, typed existing `CollectorResult`,
and fixed outcome/reason. A maximum one-MiB request limit applies. Entries are
bound to the claimed source course and validated with the existing collector
rules. Access failures contain no DOM or arbitrary exception text. Failure or
unavailable entries cannot carry accepted observations. Scanner readback paginates
at most 100 entries ordered by a stable `(job ID, ordinal)` cursor and returns
only source page type, URL, timestamp, collector, scope, outcome and fixed reasons.

A new scan-result table stores `(namespace, job_id, ordinal)` page evidence and a
job-level coverage summary. It references the queue job and imposes one result per
job. Completing a job does not mean complete coverage; missing discovery,
unsupported types, unavailable collectors, truncation and denied pages all produce
explicit incomplete reasons. Scan finish checks the claim, live demand, context,
selection and exact mapping, validates all entries, merges accepted observations
with the existing collector merge, stores coverage and changes the job state in one
`BEGIN IMMEDIATE` transaction. Any invalid input, stale claim or failure rolls
back all writes. A completed job is not replayed; a crash before commit may repeat
execution. Shared jobs survive cancellation of one of their demanding runs.

This design still needs exact source OpenAPI schemas and operation definitions,
matching typed backend/frontend models, and a testable production worker. Source
OpenAPI is authoritative and must be changed before the corresponding wire code.
The complete selected-course enumeration, route/collector combinations, reason
codes and replay semantics must be made exact in those schemas before wiring.
