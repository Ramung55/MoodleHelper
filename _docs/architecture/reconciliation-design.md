# Assessment reconciliation design (issue #33)

This design applies to persisted synthetic collection observations and reviewed mock
syllabus candidates. It does not assert live Moodle compatibility or parse a file.
The collection layer remains the authority for complete raw evidence; projection
must never rewrite or delete its records or observations.

## Identity and association

Keys are canonical JSON arrays containing the trusted store namespace, course ID,
entity kind and the source's stable identifiers. Mutable title and date never
participate in identity. An activity key uses the module type and activity-instance
ID, not the course-module ID. The latter is independently checked for consistent
association; numeric IDs of different kinds are never interchanged. Calendar event,
series and occurrence IDs remain distinct. A recurring occurrence is never folded
into a different occurrence or into the non-occurrence activity. A non-recurring
calendar record may associate with an assignment or quiz only when its validated
activity tuple, course and module all agree. Missing or contradictory associations
remain unresolved. Syllabus identity is the persisted document/candidate pair;
filename and extracted title do not identify a document. Legacy filename-only
import cannot distinguish a repeat from a distinct same-named file and retains its
existing behavior. An additive mock import path derives stable synthetic document
and candidate IDs from the selected file's SHA-256 digest, course and fixed mock row
identifier. The digest identifies bytes; it does not claim mock text was extracted
from them. Identical bytes in the same course replay the same IDs; different courses
remain isolated. Ambiguous rows without stable row identity remain unresolved.

Source projections get deterministic new IDs in a distinct namespace; pre-existing
opaque assessment IDs and references are never retroactively rewritten. Original
records and all observations remain available in collection and candidates. The
source projection includes only semantically supported dates: assignment effective
due and quiz closing; calendar start/end/date have no established deadline semantics
and cannot create a deadline. Unknown is explicit, not midnight or a guessed zone.

## Suggestions and decisions

Suggestions are pairs of independent source identities within one course and
compatible type, with equal normalized nonempty titles. Exact and date-only values
must fall on the same local calendar day in the configured timezone (date-only
already denotes a calendar day); week values must be the same week. A week paired
with a calendar date may be suggested only when that date falls within that teaching
week using the configured semester start and timezone. Invalid or unavailable
settings leave the pair unresolved. This does not turn a week into a precise date.
Different local calendar days are never suggested even if less than seven days apart;
distinct recurring occurrence identities are never suggested. These conservative
heuristics propose a pair only, never merge it. Pair IDs are canonical ordered source
keys; evidence fingerprints include matching fields and source identity, excluding
observation time. Title normalization uses Unicode NFKC, collapsed whitespace and
case folding, requiring exact normalized equality. Replays of unchanged facts retain
the same decision. A rejected pair is reconsidered only when normalized title, type
or date changes; a changed fingerprint creates a new pending proposal while retaining
the previous decision. Occurrence identity changes create a distinct source and pair
key. Confirmation remains
durable across updates to the same source identities. Different pairs are independent.
Students may also explicitly select two existing same-course compatible Moodle and
syllabus records for review when their dates differ. The server resolves existing
identities in its trusted namespace and verifies course, type, association, current
fingerprint and recurrence constraints in the transaction; it never accepts a
client-invented source identity. Explicit selection creates a review pair, not an
automatic match. Known distinct occurrences of a recurring source stay separate.

Confirmation requires a current pending fingerprint and rechecks all associations
within the same store mutation. Retries of the same decision are idempotent; an
opposite or stale decision returns an actionable conflict. A confirmed pair records
a canonical assessment ID and both original assessment IDs. Neither original is
deleted or rewritten: the reconciliation layer exposes a single logical assessment
using the Moodle assessment ID as canonical ID, combined source evidence, and an
alias mapping from both original IDs to that ID. API consumers including #22 resolve
either ID via this layer; raw Snapshot records, backup and references retain their
original IDs. The dashboard uses the same logical projection. A second pair cannot
reuse an already associated identity. References on either original resolve through
the alias map, without rewriting or deleting the references. Both original overlays
are retained; nonconflicting fields are combined in the logical overlay. Different
values for the same personal field (including override baseline) require an explicit
per-field choice before confirmation. The review card presents both values and asks
the student which to use; the choice is stored separately from both originals. Until
all conflicts are resolved both assessments remain independently visible. A later
logical-overlay edit is stored as a separate overlay for the canonical ID and takes
precedence over selected source overlays; it never erases them. This allows ordinary
confirmation of independently usable originals without losing data or references.
Absent fields are distinct from explicit false; dateOverride and its matching
overrideBase are selected and stored as a single unit, never combined from different
originals. Aliases resolve consistently on reads and overlay writes.

## Dates and transactions

Latest known Moodle due date takes priority over latest known syllabus date; an
unknown Moodle date cannot replace a known syllabus date. Equal exact instants with
different UTC offsets are equal. Date-only and week values keep their precision;
different precision is incomparable and must not be represented as certain equality.
Known disagreements display both original date values and source labels.
For each source, select its latest observation by parsed UTC observation instant,
using canonical evidence bytes as a deterministic tie-breaker; invalid legacy
timestamps sort before valid ones. If the latest Moodle fact is unknown, select the
known syllabus fact rather than reviving an older Moodle date. Incomparable known
precision is indicated as uncertainty rather than certain equality.

Collection source upsert, projection, suggestion updates and review decisions run
inside one `store.mutate` transaction and validate current state there. SQLite's
`BEGIN IMMEDIATE` serializes competing writers; validation or write failures roll
back the complete change. Snapshot changes are additive and optional for legacy
restore. Explicit replace/reset retain their existing replacement semantics. Source
OpenAPI is updated before schemas and adapters, and parity tests cover the addition.

## Additive contract and integration

An optional `Snapshot.reconciliation` object contains source associations (source
identity, course, original assessment ID and raw collection record or document and
candidate reference), pairs (ordered source IDs, fingerprint, status and canonical
assessment ID when confirmed), explicit per-field conflict choices and logical overlay
edits, plus logical assessments and aliases derived from these associations. GET
Snapshot returns this complete layer alongside the unchanged original assessments,
overlays and references; API consumers read `reconciliation.logicalAssessments`
for the one-per-logical-item view and resolve old IDs with `reconciliation.aliases`.
The logical collection includes every unmerged assessment exactly once as well as
each confirmed group once; all current assessment consumers switch to it when
present. This applies equally to #22 and the dashboard. Legacy snapshots lacking the layer
use their original assessments unchanged. Historical rejected fingerprints remain in pairs; only the current
fingerprint is actionable. Missing reconciliation on old snapshots means an empty
layer. Backup/restore round-trips the optional layer without dropping it; explicit
Snapshot replacement remains replacement.

Collection refresh calls reconciliation in the same transaction after raw upsert;
reviewing an accepted mock syllabus candidate does the same after recording its
independent assessment. Shared validated non-recurring activity identities project
to one new assessment if neither source has been projected. If independently projected
IDs already exist, use the same collision checks and logical projection as manual
confirmation; never automatically hide personal data. A stale or conflicting
association stays separate and visible for resolution.

The existing syllabus route presents pending pair cards separately from extraction
candidate review. A POST decision endpoint accepts the pair ID, fingerprint and
`confirm` or `reject` plus any explicit field conflict choices; it returns the complete
updated Snapshot. Canonical and alias overlay writes resolve to the same logical
overlay, while unassociated IDs retain existing behavior. The backend returns
409 with an actionable message on stale, opposite or unsafe decisions and leaves the
transaction unchanged. The HTTP adapter calls this endpoint; the demo adapter exposes
the same control behavior with explicitly fictional fixture data. Existing unrelated
candidate review remains available; rejecting a match never rejects its candidate.
Fixture checks cover different-day explicit selection and conflict confirmation,
recurring occurrences, absent versus false, nonconflicting and conflicting dual
overlays, coupled override/baseline, aliases, replay, concurrent writers and rollback.
