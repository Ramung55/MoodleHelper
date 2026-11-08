# Weekly counts and estimated workload (#36)

The calculation uses the saved explicit teaching calendar from #30. Weights are configurable dimensionless estimates, not hours; defaults are exam 3, assignment 2, quiz 1, other 0. Raw totals count every visible logical assessment. Outstanding count and weight include actionable items only. Hidden items are absent from every total, including unallocated.

Submission precedence: draft, not_submitted and reopened remain actionable even with a personal completion check. Submitted is non-outstanding regardless of that check. Unknown/absent source status is actionable unless personally completed. A personal check remains separate from Moodle status. Personal events use the absent-source rule.

Counting resolves existing reconciliation aliases to the authoritative logical projection, then deduplicates canonical IDs. Identical ID repetitions count once; conflicting canonical records fail explicitly. Equal titles/dates with different IDs remain separate. Effective overlay date selects a bucket without rewriting source evidence. The calculation recomputes flags and mappings instead of trusting stale supplied view.week/outstanding fields. Source arrays, overlays, settings and input order are not mutated.

Week-only values stay week-only and need a resolved teaching interval. Literal dates retain their written day; exact instants use their day in the calendar timezone. Missing/invalid calendar, unknown or invalid dates, breaks and outside weeks/dates are unallocated with the #30 mapper's reason. `unallocatedSummary` adds raw/outstanding/weighted counts alongside the existing unallocated item array.

All four weights must be finite nonnegative numbers. Zero/fractions work; missing, negative, NaN/Infinity and nonfinite aggregate overflow fail with an actionable error. Canonical ID ordering fixes both item ordering and fractional accumulation under permutations. Legacy HTTP/restore weight schemas remain permissive; domain/UI validation reports invalid saved configuration instead of pretending totals are zero. Invalid edits do not write; failed saves retain the previous saved weights/workload.

## Fixed result

The executable synthetic fixture is `frontend/src/test/workload-fixture.ts`. Calendar: Jan 4–Feb 28 2027, Asia/Qyzylorda, excluding Jan 18–24. All equal-title records intentionally remain distinct except the established h-merged aliases.

| Effective bucket | Records | Raw total | Outstanding | Weighted |
|---|---|---:|---:|---:|
| Week 1, Jan 4–10 | draft exam (checked), not-submitted assignment (checked), reopened quiz (checked), submitted exam, personally complete assignment, unknown-status quiz, personal other | 7 | 5 | 7 |
| Week 2, Jan 11–17 | merged assignment plus its duplicate/alias inputs; exact quiz Jan10 20:00Z = Jan11 local | 2 | 2 | 3 |
| Week 3, Jan 25–31 | quiz personally moved from source Week 1 to effective Week 3 | 1 | 1 | 1 |
| Weeks 4–7 | none | 0 each | 0 each | 0 each |
| Unallocated | unknown exam, break-date assignment, outside submitted quiz, Week 8 assignment, unknown personally-complete assignment | 5 | 3 | 7 |

One hidden Week 1 exam is excluded. h-moodle/h-syllabus and repeated h-merged input count once using the canonical merged projection. Changing exam/assignment/quiz to 0.1/0.2/0.3 makes Week 1 weight 0.9 (floating-point representation may include its usual final-bit rounding); zero weights preserve raw/outstanding counts. Reversed/rotated/shuffled inputs produce identical result objects and item order.

Planner shows unallocated scale and reasons; invalid configuration is shown as unavailable with a Settings link. This issue does not implement #38 notification scheduling or establish #54 live completion/resync interactions.
