# Explicit teaching calendar (#30)

Settings → Explicit teaching calendar accepts both inclusive boundaries, a calendar timezone and comma-separated excluded full-week start dates. Edit and inspect the complete draft preview, then Save. Cancel writes nothing. Failed saves retain the draft and the previously saved map. Legacy semester/display fields remain compatible, but do not establish a teaching calendar. Demo/sample snapshots do not manufacture one.

The optional nonnullable `teachingCalendar` group is a complete nested replacement under the existing shallow settings PATCH. Omission retains it; an empty exclusion list clears breaks. There is no null/reset operation. PATCH and Snapshot restore validate the complete group before atomic persistence.

Supported calendars contain 1–60 complete seven-day slots anchored exactly at the entered start, with 1–30 nonexcluded teaching weeks. Break starts must be unique, aligned and wholly within the explicit boundaries. Partial weeks and irregular overrides are unresolved (#52); no end date, Monday alignment or institutional numbering is inferred.

Example: 2027-01-04 through 2027-02-28, excluding 2027-01-18. Week 2 is Jan 11–17, Jan 18–24 is a break, Week 3 is Jan 25–31, and Week 6 is Feb 15–21. The break pauses the teaching counter.

The finite case-insensitive evidence grammar accepts `Week 6`, `Weeks 6`, `неделя 6`, `недели 6`, `неделе 6`, and `неделю 6`, with whitespace before a numeric week. Only integer 1–30 maps; multiple/conflicting/ranged references remain unresolved. Unsupported ordinal/reverse wording is not interpreted. Original text, parent mention ID, digest and source location remain in the existing detector evidence; preview adds an interval without changing `{kind:'week',week:6}` or creating an assessment/deadline. Saving a new map recomputes visible intervals from the same source values and overlays.

Date-only sources map by their written calendar date. Exact instants map by their day in the calendar timezone. Dates outside the boundaries or inside breaks remain unallocated. Missing/invalid calendar and out-of-range weeks report unresolved reasons. Planner, deadline groups, current week and source match suggestions use the explicit slots.

The supported timezone-name boundary is pinned in `shared/src/teaching-timezones.json`: 419 unique names from the installed Node Intl `supportedValuesOf('timeZone')`, plus UTC. It includes Asia/Almaty, Asia/Qyzylorda, fractional-offset Asia/Katmandu and DST America/New_York. The browser uses its actual Intl timezone rules, including historical/DST transitions; no fixed offset is guessed. Python validates names against the same catalog. Backend heuristic comparison uses installed ZoneInfo data when available, UTC directly; if timezone data is unavailable it safely withholds the exact-to-week suggestion. The name catalog does not claim Python tzdata is installed. No dependency, network calendar or offset subprocess is introduced.

Verification covers memory/SQLite atomic invalid PATCH/restore, complete replacement and omission, old/new Snapshot parity, HTTP restart persistence, bilingual evidence mapping, break boundaries and rendered draft save/failure/cancel behavior. DOM integration is not a claim of live Moodle/browser-session verification.
