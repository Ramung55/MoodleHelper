# Explicit local syllabus dates (#29)

**Interpret explicit dates** operates only on #28's source-row proposals. It
preserves the parent mention ID, excerpt, original offsets and PDF/DOCX location.
Every date result remains unconfirmed; no API call, backend document/candidate ID,
confirmed assessment or persistence is introduced. Changing explicit context
clears the old preview. Dataset/abort/generation checks fence publication, and
unavailable/changed context clears evidence. The UI caps the preview at 2,000
expressions, with at most 100 expressions per source row.

## Supported grammar

- ISO `YYYY-MM-DD`.
- Day plus English/Russian month plus optional four-digit year, e.g.
  `12 March 2027`, `12 марта 2027`, `12 мар. 2027`.
- English/Russian month plus day and optional comma/year, e.g. `March 12, 2027`.
- Numeric `DD/MM/YYYY`, `MM/DD/YYYY`, or corresponding dotted forms, and
  yearless forms. The separator must be consistent within one expression.
- An immediately following 24-hour `HH:mm`, optionally introduced by `T`, `at`
  or `в`, with written `Z`, `±HH:mm`, `UTC`, or supported IANA zone spelling;
  otherwise an explicitly supplied trusted document/course IANA zone is needed.

Month vocabulary is full English names plus Jan/Feb/Mar/Apr/Jun/Jul/Aug/Sep/Sept/
Oct/Nov/Dec, and Russian nominative/genitive month names plus янв/фев/мар/апр/
июн/июл/авг/сен/сент/окт/ноя/нояб/дек. Abbreviations may end with a dot. Matching
is case-insensitive and preserves exact original wording. This is not universal
natural-language parsing: relative prose, ordinal-day suffixes, two-digit or other
unsupported years, 12-hour clocks, seconds and ambiguous zone abbreviations stay
unresolved. Written clocks are never silently reduced to date-only output.

## Explicit context and precision

Numeric order is resolved only when exactly one calendar-valid interpretation
exists, both interpretations are identical, or explicit DMY/MDY document/course
metadata resolves it. `03/04` is ambiguous even in Russian prose. Browser language,
OS zone, hostname, current date and dashboard defaults provide no locale evidence.
Invalid/conflicting metadata yields an actionable unresolved reason.

Missing years remain unresolved unless caller-supplied calendar semester start
and end contain exactly one valid occurrence. Both bounds must be real dates,
ordered, and span at most five years. Zero/multiple placements are unresolved.
Inferred-year provenance retains those explicit bounds and original yearless
wording; no semester end is derived from teaching-week count or breaks.

Calendar days and leap years are validated. Date-only output is the existing
`{kind:"date",date:"YYYY-MM-DD"}` without midnight or timezone. A written time
without zone evidence retains wall-clock metadata and an unknown date. Exact
output rejects impossible clocks and nonunique/nonexistent IANA local times.
The reused #34 helper exposes all matching instants for this check while keeping
the original personal-input convenience wrapper unchanged.

Written fixed offsets are limited to ±14:00, retained in the ISO expression and
zone provenance. `tz:"UTC"` is explicitly a display-zone contract for such instants,
not an assertion that the source observed an IANA region. Written/supplied IANA
zones retain their written/document/course provenance. No host zone is used.

## Association and identity

Dates are scanned only inside their exact parent source unit. Multiple dates keep
separate original-expression offsets and labels. Distinct opens/closes/due roles
may retain separate proposed dates; duplicate roles, unlabeled ranges, multiple
assessment mentions or unassociated additional/preceding clocks are ambiguous.
No nearest-date heuristic or adjacent-row/page borrowing is used. Unsupported
associations retain original text for review. Teaching-week wording remains raw
for #30.

Date proposal IDs append original expression start/end and label to the stable
parent mention ID. Parsed values, selected locale, inferred year, timezone and
current time do not identify a proposal. Changing context can change its proposed
value while retaining the original source identity. The parent mention is never
mutated. Invalid/unresolved dates use the existing unknown DateValue plus explicit
state/reasons and wall-clock/year/zone metadata where available.

Tests cover actual English/Russian PDF/DOCX extraction → #28 detection → parsing,
numeric ambiguity and context, year inference, leap dates, clocks, fixed offsets,
DST gaps/overlaps, labels/ranges, invalid/unsupported grammar and row isolation.
Rendered tests show original proposals and missing-year uncertainty until explicit
semester bounds justify a unique year, with no document network transfer.
