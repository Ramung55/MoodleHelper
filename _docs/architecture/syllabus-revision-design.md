# Explicit syllabus revision design (#22)

The student explicitly chooses a reviewed candidate and a target syllabus source;
neither matching titles nor document digests establish a revision. The existing
syllabus review shows both original documents, titles, precise dates, excerpts and
locations, and labels mock extraction before confirmation.

The additive `syllabusRevisions` Snapshot array contains one record per target
source association: `sourceId`, `assessmentId`, `revision` (nonnegative integer),
and ordered `links` containing candidate/document IDs, source association ID,
original assessment ID, accepted date, decision time and revision number. Its
original candidate is revision zero, established without a history event. Each
explicit link adds one monotonic revision even for an equivalent date; equivalent
dates add no event. Candidate/document records, original assessment evidence,
source associations and original IDs remain unchanged. A candidate belongs to at
most one revision group in addition to its own original association; linking reuses
an otherwise unlinked original source as a member and must reject an already
linked candidate, target source that is itself a linked member, or a cycle.

Introduce a preview command accepting target source ID and incoming candidate ID.
It computes a fingerprint over the target stream revision and current source,
candidate, document, assessments, aliases, pair decisions and personal overlays.
It returns the current revision, fingerprint and two evidence summaries: the
target's current accepted revision document/date and the incoming reviewed
candidate/document, including excerpt, location and original review time. The
fingerprint binds the complete normalized command and relevant source, decision
and personal state; 409 responses reveal neither personal values nor fingerprint
inputs. Both source identities and the target's known reviewed baseline and
current revision are validated again inside the transaction. A confirm command
takes those IDs, revision and fingerprint. Within one
`store.mutate`, it recomputes the preview against current state before accepting.
An identical previously committed request is idempotent even if the stream has
since advanced without writing or rebuilding aliases; a changed request, stale preview, ambiguous identity or conflicting
concurrent link returns an actionable 409 without changing state. Store the exact
accepted command fingerprint on each link to recognize retry after restart/backup.

Both source associations must be unique syllabus records in the same namespace
and course; document and candidate IDs must resolve uniquely, candidate status is
confirmed/corrected/auto, date must pass existing collected-date validation and be
known, and assessment type must agree. Incoming source must have an unambiguous
original `syl-<candidate>` assessment. Reject candidate/assessment membership in
any pair decision (pending, confirmed or rejected) or existing revision group, and reject any incoming overlay,
submission or logical overlay edit that could be lost by linking. Target existing
confirmed Moodle pair and its overlay decisions are retained. Such conservative
rejection avoids guessing how to combine personal state; it does not delete or
rewrite it. Existing pending and rejected pair records are preserved and block the
link; no rejected pair is resurrected or silently suppressed. Later automatic pair
generation excludes linked incoming members. No revision mutates the target's
personal overlay or confirmed #33 pair decision.

Linking projects the incoming original assessment as an alias of the target's
current canonical logical assessment; its source evidence is retained in the
logical assessment as well as the original. Existing Moodle/syllabus pair aliases
and original overlays remain untouched. The target's accepted syllabus date comes
from revision state; incoming linked member evidence never competes separately in
current-date selection. History refers to the target original assessment/source,
resolves through aliases, and additionally stores the selected candidate/document
provenance and decision time. Moodle and syllabus tracking remain separate.

At first link, baseline comes from the existing target's own reviewed original
candidate, not the incoming candidate or a guessed newest evidence. The incoming
known date is compared to that baseline and, if changed, one event is written.
Revisions then compare to the last accepted linked date; A→B→A creates two events.
Server-generated decision timestamps are display provenance; revision integers,
not wall-clock timestamps or document uploads, order these decisions. Missing or
unknown candidate dates reject preview/confirmation and never assert removal.

The commit, alias/projection rebuild, source-state update and history append all
occur within SQLite's existing serialized `store.mutate` transaction. No new
migration is needed: the optional typed state survives ordinary Snapshot backup,
restore, restart and explicit replacement; legacy snapshots omit it. Source
OpenAPI is updated before coordinated Python, frontend Zod, adapter and bridge
models. No claim is made that the mock importer parses real documents.
