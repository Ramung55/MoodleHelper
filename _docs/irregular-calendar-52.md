# Partial holidays and explicit teaching ranges (#52)

Settings → Explicit teaching calendar extends the unchanged seven-day baseline with optional partial holidays and explicit teaching-week ranges. Every interval is inclusive. Save submits the whole validated calendar once; pending/failure/cancel behavior preserves the saved map. Dates, syllabus wording, digest/location and personal overlays are not rewritten.

Each partial holiday has `startDate`, `endDate` and explicit `numbering: preserve|unresolved`. It must be shorter than seven days within one anchored nonexcluded baseline slot. Intervals cannot overlap each other or full excluded slots. Preserve is the student's explicit assertion that institutional numbering stays unchanged. Unknown numbering does not default to preserve: its containing baseline week and all later baseline weeks remain unresolved. Earlier weeks remain resolved; no holiday shifts or renumbers anything automatically.

An explicit `{week,startDate,endDate}` replaces only that week and can resolve it despite prior uncertainty. It may have any positive inclusive length within the semester. A week1..30 absent from the baseline may be explicitly established where a nonoverlapping range is available; missing neighbors are never invented. Unoverridden uncertain weeks remain uncertain. Overrides cannot intersect another resolved range (including one shared endpoint) or any full excluded slot. Adjust conflicting named weeks together in the same draft; no neighbor is silently moved. Partial holidays are annotations inside resolved ranges, not removed days.

For 2027-01-04 through 2027-02-28 with no full exclusions:

| Configuration | Week 2 | Week 3 | Consequence |
|---|---|---|---|
| Jan13 holiday, preserve | Jan11–17 | Jan18–24 | Same numbering and workload as baseline |
| Jan13 holiday, unresolved | Unresolved | Unresolved | Week1 remains known; later baseline weeks are unallocated |
| Unknown holiday + Week2 override Jan11–16 | Jan11–16 | Unresolved | Only Week2 is resolved; Jan17 is uncovered |
| Preserve holiday + Week2 override Jan11–16 | Jan11–16 | Jan18–24 | Week3 is unchanged; Jan17 is uncovered |
| Change Week2 override end to Jan15 | Jan11–15 | Unchanged | Week2 source precision/wording remains; Jan16 exact/date-only items become unallocated |
| Week2 override Jan17–20 with unchanged Week3 | Rejected | Previous map remains | Overlap with Jan18–24; explicitly adjust Week3 too |

The existing #30 finite bilingual grammar still preserves `Week 2` / `неделя 2` as `{kind:'week',week:2}` plus a derived range. Actual bilingual DOCX tests similarly map `Week 6` / `неделя 6` to explicitly supplied intervals while retaining parent IDs, original digest and paragraph locations. This is configured student knowledge, not observed SDU numbering.

#36 consumes the same resolved projection. For an outstanding Week2 exam and a Jan16 date-only quiz (weights3/1), unknown numbering yields unallocated2/outstanding2/weighted4. Explicit Week2 Jan11–16 yields Week2 total2/outstanding2/weighted4; shortening it to Jan11–15 yields Week2 1/1/3 and unallocated1/1/1. Source evidence is unchanged. Exact instants use the calendar-zone day, literal dates their own day; only a unique resolved interval is eligible. Uncovered/outside/uncertain days stay unallocated.

Optional arrays `partialBreaks` (max60) and `weekOverrides` (max30) are absent-as-empty. Present arrays reject null, unknown shapes, duplicate week numbers and invalid real dates. Old calendars omitting both remain unchanged. The entire nested calendar is replaced under existing shallow PATCH: an older client's complete group that omits arrays removes previously saved extensions, rather than silently merging forgotten settings. Empty arrays explicitly clear them; omitting the whole teachingCalendar property retains the group. PATCH/restore validates the complete proposed map atomically. Python and shared browser validation use the same rules; backend matching consumes actual variable-length resolved ranges without fixed-seven-day override arithmetic.

Automated evidence includes real-provider rendered draft validation/failure and workload updates, actual synthetic bilingual file extraction, coordinated Python/Zod/OpenAPI/bridge validation, legacy replacement semantics and HTTP SQLite restart persistence. No live institutional calendar, native-browser session or numbering claim is made. No new dependency or wire tightening of legacy semester/date fields is required.
