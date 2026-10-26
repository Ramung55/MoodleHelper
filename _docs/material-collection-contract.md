# Course material parser contract (#17)

PM decision before code, 2026-10-26. All five original acceptance criteria remain
required. They are locally testable with invented structural DOM fixtures. #17
says use #3/#4 supported forms; it does not impose #14's ONLY verified variants
restriction. This is an offline synthetic parser policy, never evidence of live
SDU compatibility. #3 observed coverage stays UNVERIFIED; #4 resource/folder
data-fact documents are negative parser inputs, not supported DOM or truth maps.

## Boundary and model

Implement a pure collector in extension/src/moodle-materials.ts accepting readonly
MoodleAccessInput[], trusted selectedSourceCourseIds and an explicit observedAt.
Selection uses canonical positive decimal source ID strings, never opaque local
Course.id or guessed title/code. Reuse #13 zoned timestamp validation and preserve
the supplied string. Every page runs actual #10 access detection, even if batch
arguments are invalid; inaccessible inputs retain the fixed access outcome and
yield no parsed records. No network, file bodies, DOM writes, navigation, logging,
storage, backend, bridge or extension runtime dispatch belongs here.

Return detached observations, review, exclusions, diagnostics, pages and aggregate
coverage complete|partial|none with scope=supplied_pages_only. Each page records
index, access, candidateCount, coverage and paginationPending. Diagnostics and
exclusions contain only fixed reasons plus numeric page/record indices. Review
records retain only validated safe candidate facts and fixed reasons; unsafe raw
URLs, private diagnostic strings and conflicting unvalidated identities never leak.
Successful records carry observedAt, sourcePageUrl and fixed structural location.

RawMaterialObservation has sourceCourseId; sourceCourseModuleId; sourceModuleType
(resource|url|folder); optional sourceResourceId (module instance, distinct from
course module); stable resourceKey; sourceUrl (canonical module page); optional
destinationUrl; kind (file|link|folder); title and section as Known<string>|Unknown;
fileType as Known<pdf|docx|pptx|link|video|other>|Unknown; mimeType as
Known<string>|Unknown; and optional parentResourceKey. Unknown is {kind:unknown},
known is {kind:known,value:...}. Section absence must not invent a week. A folder
record has explicit unknown file type unless actual metadata supplies a known
type; it is distinguished by kind. Observed safe destination is distinct from
source/provenance URL. A valid identity with missing title/section/type/MIME still
survives with explicit unknown fields and missing_metadata review/diagnostic.

This is NOT Material/Snapshot: current Material.fileType=other is KNOWN other,
never a substitute for unknown, and current Material lacks folder relationships,
raw identity, MIME, uncertainty and source provenance. Before #18/#20 backend
ingestion, agreed additive boundary is optional nonnullable Material.sourceDetails
retaining the complete raw observation, with unresolved safe candidates in a
separate raw review queue. Folder nodes must persist as material records whose
sourceDetails.kind=folder; parentResourceKey references the stable source key,
not a title/section path. Legacy Material projection must retain sourceDetails
and explicitly label unknown fields; it cannot silently convert unknown into a
known other. Coordinate Zod/OpenAPI/Python, persistence and backup round-trip
checks at ingestion, including resourceKey-to-local-ID mapping. No schema or API
change is needed for this pure parser. The #5 wire gap stays open until then.

## Synthetic structural vocabulary

All attributes below are invented structural evidence, not observed Moodle
selectors. Whitespace-normalize visible labels. Fixtures include genuine #10
account navigation and canonical course/activity links; markers alone do not
establish access. Requested/final routes must agree on module/course identity.

Supported course pages are canonical /course/view.php?id=<courseId> with one
main[data-region=course-content], one nonblank h1, and exactly one matching
a[data-role=course-link]. Sections are section[data-region=course-section], with
at most one h2. Modules are article[data-region=material] directly within a
section; data-module-type is resource|url|folder; data-course-module-id is required,
data-resource-id optionally supplies the distinct module-instance ID. Exactly one
a[data-role=material-link] points to the matching canonical module view URL. Its
visible text supplies title. At most one a[data-role=destination] supplies a
destination. Its optional type attribute supplies explicit MIME. A recognized
data-file-type value supplies type metadata; absence/unrecognized values are
unknown, never a filename/title inference. A data-file-type=other is known other.
Contradictory recognized type/MIME evidence makes type unknown with type_conflict.
MIME mappings: application/pdf=>pdf, Office DOCX/PPTX official MIME=>docx/pptx,
video/*=>video; an explicit unsupported MIME is known other. URL module kind
establishes known link unless conflicting explicit metadata requires review.

Module pages are canonical /mod/(resource|url|folder)/view.php?id=<moduleId>, one
main[data-region=activity] with one nonblank h1, exactly one canonical course link,
and data-course-module-id matching route. data-module-type agrees with route;
optional data-resource-id remains a separate instance ID. Optional
[data-role=material-section] supplies section; main h1 supplies title. At most one
destination anchor has the same meaning as above. No destination means an unknown
destination, recorded as missing_metadata; source module URL remains usable.

Folder pages additionally contain exactly one ul[data-region=folder-contents].
Nested li[data-region=folder-entry] nodes have data-entry-kind=file|folder and a
required canonical decimal data-file-id or data-folder-id respectively. Each has
one direct a[data-role=entry-link]; nested folders contain at most one direct ul
of children. Its nearest containing folder entry establishes parentResourceKey;
top-level entries refer to the module folder root key. Reject ambiguous nesting,
duplicate IDs with contradictory parents, self-links/cycles, and children without
a valid parent; do not flatten them into unrelated files. Child title is direct
anchor text; inherit only established course/section, not guessed file type.
File links may use the safe pluginfile vocabulary below; folder links use
/mod/folder/view.php?id=<sameModuleId>&folder=<folderId>. Root sourceUrl remains
the canonical module URL; destinationUrl retains the validated child reference.

Explicit empty state is one [data-role=materials-empty] for course modules, or
[data-role=folder-empty] inside an empty folder list. Empty without the appropriate
marker, or a marker alongside candidates, is unconfirmed/conflicting and partial.
main/list data-incomplete or data-truncated and nav[data-region=material-pagination]
containing a[href], button or rel=next prevent complete coverage. Nested/duplicate
headings, missing/multiple links and malformed candidate nodes produce explicit
record diagnostics rather than dropping them unnoticed. Legacy #4 fact-only,
login, denied, malformed/truncated and arbitrary unsupported pages yield none or
partial with access/structure reasons. A successfully parsed empty supported page
can be complete only for that supplied page; never claim all course resources.

## Identity and URL rules

All IDs are positive decimal STRINGS without Number coercion. Module IDs are
not module-instance IDs. Stable key is a canonical JSON tuple scoped to origin
and course: [origin,courseId,moduleType,"module",courseModuleId] for module roots;
[origin,courseId,"folder",courseModuleId,"folder",folderId] for child folders;
[origin,courseId,"folder",courseModuleId,"file",fileId] for child files. Optional
instance/context IDs are provenance, not substitutes that change identity when
new metadata appears. No title/filename/query/revision/time participates in a key.
Repeat references to the same key deduplicate in first-seen order; distinct
same-title IDs remain distinct. Known duplicates may fill unknown metadata;
conflicting known fields become sticky unknown with field_conflict review, never
last-writer wins. Contradictory course/module/parent identity excludes the unsafe
association and prevents complete coverage. Preserve validated alternate references
in a references array, not multiple duplicate material records.

Moodle URLs require exact HTTPS moodle.sdu.edu.kz with no credentials, nondefault
port, fragment, whitespace, backslash or dot-path aliases. Course/module canonical
queries contain exactly id=<matchingId>. Folder child queries contain exactly id
and folder matching structural IDs. Reject extra/duplicate/encoded query keys,
empty query tokens, access/sesskey/signature/token parameters and encoded aliases.
Never merely strip secrets into an apparently working URL. Safe pluginfile form:
/pluginfile.php/<contextId>/mod_folder/content/<revision>/<pathSegments> for folder
files; /pluginfile.php/<contextId>/mod_resource/content/<revision>/<pathSegments>
for resource destinations. Canonical decimal context/revision; nonempty safe path
segments; no dot segments, encoded separators, credentials, fragments or query
except optional literal ?forcedownload=1. Preserve safe destination precisely;
revision, path and forcedownload never supply stable identity. Child identity
requires explicit data-file-id, never a guessed filename/context/revision ID.
Invalid/ambiguous pluginfile forms enter fixed unsafe_url review/exclusion.

External destinations permit absolute HTTPS, valid DNS/IP host, no credentials,
nondefault port, whitespace, control characters, backslash or malformed escapes.
Preserve accepted path/query/fragment exactly. Conservative query policy accepts
only literal unique keys id,page,lang,v with nonblank simple [A-Za-z0-9._~-]+ values;
fragment permits only [A-Za-z0-9._~-]+. Reject all other keys, encoded keys,
JWT-like/credential/token/signature names or values, nested URLs and ambiguous
secret-bearing path/fragment forms as unsafe_external_url, without reflecting the
URL. Uncertain URL privacy goes to fixed-reason skip/review, not redaction. This
bounded vocabulary intentionally rejects some benign URLs; expand only with
explicit safe examples. Accepted external links retain their precise destination
and are never fetched or followed for privileged collection.

Exact external privacy boundary (PM clarification before code): accept root path
or slash-separated nonempty literal segments matching [A-Za-z0-9._~-]+, with an
optional trailing slash; reject repeated slashes, dot/dot-dot segments, ALL percent
escapes, empty query tokens/values, duplicate keys and even an empty trailing ?
or #. Query keys are case-sensitive literal id,page,lang,v only. Fragment, query
values and each path segment must additionally pass all three privacy checks:
(1) reject a case-insensitive sensitive word delimited by start/end or any of
dot, underscore, tilde, hyphen: token, access, sesskey, auth, authorization, key,
api, signature, secret, password, credential, bearer; this also rejects compound
access_token and api_key; (2) reject a string containing three nonempty dot-separated
segments each matching [A-Za-z0-9_-]+ (a conservative JWT-like pattern, even if
otherwise ordinary text); (3) reject any contiguous [A-Za-z0-9_-] run of length
32 or more. No extra entropy guess or secret-name synonym heuristic is required.
These are intentionally bounded privacy checks, not a guarantee that arbitrary
human-authored text cannot contain a secret. Examples: /lectures/week-1.pdf?id=42
#part-2 and /watch?v=abc123 are accepted precisely; /access_token/abc,
/notes?lang=secret, /a.b.c, /<32-letter-run>, /notes%2Fprivate, /notes?ID=42 and
/notes# are rejected. Reject noncanonical host spelling, encoded host aliases,
empty explicit port and explicit default :443 too, so acceptance never normalizes
an input into a different destination. Absolute external href must already equal
the URL serialization returned by the URL parser; return the original href.

MIME safety boundary: inspect only an anchor's type attribute. Known MIME values
must be literal lowercase ASCII type/subtype matching
[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*, total length <=127,
with neither parameters nor whitespace; require the same three privacy checks
above independently on type and subtype. Safe syntactically valid unsupported
MIME remains known other and retained known MIME. Missing is unknown MIME;
malformed/unsafe MIME is unknown with fixed invalid_mime reason, and its original
string is never returned in observations, review or diagnostics. This syntax is
a deliberately narrow collector vocabulary, not a claim to recognize every MIME.

## Verification and handoff

Engineer must make this documented vocabulary exact in source comments/tests
before implementation (if any ambiguity requires a small contract correction,
record it before code; preserve all original criteria). Fixtures are inert DOM
builders in frontend/src/test/moodle-materials.test.ts and an optional local
test helper; never replace #4 files or add a manifest truth map. Allowed files:
new parser/test, this contract, #5 inventory cross-reference and only a minimal
shared URL helper if actually needed. No dependencies/install, download behavior,
syllabus ranking (#23), library UI (#40), Chrome/download work (#41), backend,
storage or unrelated architecture changes.

Check all original AC: lecture external links, explicit PPTX/PDF/unknown metadata;
nested folder children and parent identities without fetch; repeat/module/revision
variants plus different same-title files; precise safe external destination with
zero navigation/fetch calls; denied folders, unknown fields and partial/paginated
lists with explicit coverage/errors. Add negative controls for real #10 gate,
fact-only fixtures, mismatched/huge IDs, missing selection/course trust, unsafe
credentials/tokens/encoded URLs, conflicting duplicate facts, empty listings,
malformed nesting and mutation isolation. URL rejection must not expose secrets
in ANY output. Verify all #10/#11/#13/#15 regressions and run existing fixture
hygiene checks; no new tests are claimed by this PM decision. Local testability
is READY; live compatibility is separately blocked by #3 evidence, not an invented
UI requirement or a reason to skip this bounded pure parser.
