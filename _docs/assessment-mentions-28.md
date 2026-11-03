# Deterministic local assessment mentions (#28)

After explicit local PDF/DOCX extraction, **Find assessments** previews possible
assessments. Every proposal is labeled unconfirmed with an unknown date. This
operation does not invoke legacy mock import/review, create Snapshot candidates,
persist results or confirm assessments. It checks the current dataset before and
after processing, uses existing abort/generation fences, and clears proposals on
extraction/source/context replacement or cancellation. No document content leaves
the browser. Existing demo candidates remain separate and mocked.

## Supported terms and uncertainty

The bounded `mentions-1` vocabulary is case-insensitive English exam/examination
(including plurals and "final exam"), quiz/quizzes, test/tests,
assignment/assignments and homework; Russian экзамен, тест, контрольная работа,
задание and домашнее задание with the explicitly enumerated common inflections in
the detector regex. This is not full Russian morphology or semantic understanding.
Words must have Unicode letter/number boundaries, preventing substring matches
inside unrelated words. Matching runs directly on original Unicode strings;
UTF-16 start/end offsets index the original excerpt, with no normalization that
changes offsets. Evidence retains exact original capitalization, text and spans.

Each proposal contains keyword type, a bounded keyword/ordinal display title,
whole same-source-row excerpt, original mention span, source location and raw
same-row schedule wording. Scheduling hints (week/due/deadline/date-looking words)
are only uncertainty signals. No calendar or teaching-week value is interpreted.
Missing hints receive a no-scheduled-evidence reason. Short bare labels without
schedule evidence are heading-uncertain; grading/rules/attendance/percentage prose
is explicitly policy-uncertain, including "quizzes 20%" and Russian examples.
"Final" alone never identifies an exam. Multiple mentions in one row remain
separate uncertain proposals with their own offsets; no dates or columns are
arbitrarily assigned. Even clear-looking schedules remain unconfirmed for #29/#31.

## Evidence boundaries and identity

PDF units are individual original extracted rows, preserving one-based page and
every item's transform/width/height. DOCX units are individual body paragraphs or
whole original table rows, preserving original cells and each cell paragraph's
part/body/table/row/cell indices. Cell text joins with tabs and paragraphs with
line breaks solely to provide same-row mention offsets; original cells remain
available. A source unit never borrows words or dates from another row, paragraph,
page or table. Complex rows with multiple mentions are explicitly ambiguous.

Proposal IDs are SHA-256 over a canonical tuple of detector version, dataset ID,
course ID, document digest, deterministic source-location key, original mention
start/end and type. PDF location keys use original page/item geometry, DOCX keys
use original paragraph or table-row locations. Titles, timestamps, UUIDs and
traversal-global counters are not identity inputs. Reordering independent pages
or blocks does not change IDs; repeated titles at different locations and different
dataset/course/document versions remain distinct. Identical repeated locations
deduplicate; conflicting evidence at the same location fails instead of selecting
arbitrarily. A future detector-version change creates new proposal IDs; persisted
review migration must be deliberately designed by its owning issue.

The generic provenance-bearing unit adapter also accepts OCR page/region evidence;
its tests explicitly label synthetic OCR regions. This is an adapter contract,
not implementation or approval of real OCR, which remains #27. Production local
extraction currently supplies only PDF/DOCX units.

Limits: 10,000 source units, 10,000 UTF-16 characters per unit, one million total
characters and 1,000 proposals; exceeding a limit fails without publishing partial
results. Async SHA-256 boundaries check cancellation. These bounds do not make
the detector a general-purpose document understanding model.

Verification uses actual #25 PDF.js and #26 native DOCX bilingual fixture outputs,
plus focused bilingual heading/policy/date-less/multiple-mention/table-row cases.
Tests check exact source geometry/cells, adjacent-row isolation, stable replay and
page reordering, context separation, duplicate conflicts, cancellation and a
rendered actual DOCX → detector preview with no network calls. They do not claim
real OCR or live Moodle access.
