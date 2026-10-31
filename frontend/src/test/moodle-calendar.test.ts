import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectMoodleCalendar } from "../../../extension/src/moodle-calendar";
import {
  calendarDate as date,
  calendarEvent as event,
  calendarPage as page,
  calendarInput as input,
} from "./moodle-calendar-fixtures";
import { login, denied, account, origin } from "./moodle-access-fixtures";
const observed = "2026-10-26T12:00:00+05:00";
const collect = (html = page(), selection = ["101"]) =>
  collectMoodleCalendar([input(html)], selection, observed);
describe("calendar raw facts and independent selection (AC1)", () => {
  it("retains independent event/course/activity/module IDs, dates and fixed raw paths", () => {
    const r = collect(
      page(
        event({
          id: "900719925474099312345",
          dates: date() + date("end", "2026-10-25T20:00:01.120+05:00"),
          extra:
            '<a data-role="activity-link" data-activity-id="202" href="/mod/quiz/view.php?id=303">Quiz</a>',
        }),
      ),
    );
    expect(r.coverage).toBe("complete");
    expect(r.observations).toEqual([
      {
        sourceEventId: "900719925474099312345",
        sourceCourseId: "101",
        title: "Fictional assessment",
        sourceUrl: `${origin}/calendar/view.php?event=900719925474099312345`,
        observedAt: observed,
        start: {
          value: { kind: "exact", iso: "2026-10-25T18:30:00+05:00", tz: "Asia/Almaty" },
          rawText: "Displayed date",
          location: "calendar.start",
        },
        end: {
          value: { kind: "exact", iso: "2026-10-25T20:00:01.120+05:00", tz: "Asia/Almaty" },
          rawText: "Displayed date",
          location: "calendar.end",
        },
        activity: {
          moduleType: "quiz",
          sourceActivityId: "202",
          sourceCourseModuleId: "303",
          sourceUrl: `${origin}/mod/quiz/view.php?id=303`,
        },
      },
    ]);
  });
  it("preserves date-only without fabricated time or absent optional link", () => {
    const r = collect(page(event({ dates: date("date", "2026-10-25", "") })));
    expect(r.observations[0].date?.value).toEqual({ kind: "date", date: "2026-10-25" });
    expect(r.observations[0]).not.toHaveProperty("start");
    expect(r.observations[0]).not.toHaveProperty("activity");
  });
  it("preserves independent date-only interval ends without exclusive-midnight conversion", () => {
    const c = collect(
      page(event({ dates: date("start", "2026-10-25", "") + date("end", "2026-10-26", "") })),
    ).observations[0];
    expect(c.start?.value).toEqual({ kind: "date", date: "2026-10-25" });
    expect(c.end?.value).toEqual({ kind: "date", date: "2026-10-26" });
  });
  it("supports canonical absolute 443 links and ignores hostile document base", () => {
    const html = page(event()).replace(
      'href="/calendar/view.php?event=501"',
      `href="${origin}:443/calendar/view.php?event=501"`,
    );
    expect(collect('<base href="https://evil.invalid">' + html).observations[0].sourceUrl).toBe(
      `${origin}/calendar/view.php?event=501`,
    );
  });
});
describe("fixed exclusions and review association (AC2/3)", () => {
  it.each([
    ["site", "site_event"],
    ["personal", "personal_event"],
    ["other", "non_assessment"],
  ])("excludes %s by structural kind", (kind, reason) => {
    const r = collect(page(event({ kind, title: "Exam for selected course" })));
    expect(r.observations).toEqual([]);
    expect(r.exclusions).toEqual([{ reason, pageIndex: 0, recordIndex: 0 }]);
  });
  it("uses source selection without title guessing", () => {
    const r = collect(page(event({ course: "999", title: "101 selected course" })));
    expect(r.exclusions[0].reason).toBe("unselected_course");
    expect(r.observations).toHaveLength(0);
  });
  it.each([undefined, "opaque-course-id", "0", "01", "+1", 1, null])(
    "rejects invalid source selection %s",
    (id) => {
      const r = collectMoodleCalendar([input()], [id] as string[], observed);
      expect(r.error).toBe("invalid_batch_arguments");
      expect(r.observations).toEqual([]);
      expect(r.pages[0].access.status).toBe("accessible");
    },
  );
  it("empty selection never automatically chooses observed course", () => {
    expect(collect(page(), []).observations).toEqual([]);
  });
  it("missing course retains facts in review without assigning sole selected course", () => {
    const r = collect(page(event({ course: null })));
    expect(r.review[0].reasons).toEqual(["missing_course"]);
    expect(r.review[0].candidate).not.toHaveProperty("sourceCourseId");
    expect(r.review[0].candidate.start?.value.kind).toBe("exact");
    expect(r.coverage).toBe("partial");
  });
  it.each([
    ['href="/course/view.php?id=101"', 'href="/course/view.php?id=102"'],
    ['<a data-role="course-link" href="/course/view.php?id=101">Course</a>', ""],
  ])("reviews unreliable association", (from, to) => {
    const r = collect(page(event()).replace(from, to));
    expect(r.review[0].reasons).toContain("unreliable_course");
    expect(r.review[0].candidate).not.toHaveProperty("sourceCourseId");
  });
  it("unknown kind is explicit review regardless of title", () => {
    const r = collect(page(event({ kind: "exam" })));
    expect(r.review[0].reasons).toContain("unknown_kind");
    expect(r.observations).toEqual([]);
  });
  it("unknown date retains evidence while missing date is separate", () => {
    const r = collect(
      page(
        event({
          dates: '<span data-date-field="start" data-date-unknown>Pending instructor</span>',
        }) + event({ id: "502", dates: "" }),
      ),
    );
    expect(r.review.map((x) => x.reasons)).toEqual([["unknown_date"], ["missing_dates"]]);
    expect(r.review[0].candidate.start).toEqual({
      value: { kind: "unknown" },
      rawText: "Pending instructor",
      location: "calendar.start",
    });
  });
});
describe("canonical identity dedup and conflict safety (AC4)", () => {
  it("deduplicates repeated views and retains first offset representation at equal precision", () => {
    const r = collectMoodleCalendar(
      [input(), input(page(event({ dates: date("start", "2026-10-25T13:30:00Z") })))],
      ["101"],
      observed,
    );
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0].start?.value).toMatchObject({ iso: "2026-10-25T18:30:00+05:00" });
    expect(r.coverage).toBe("complete");
  });
  it("keeps distinct event IDs and recurring occurrences despite equal titles and times", () => {
    const r = collect(
      page(
        event() +
          event({ id: "502" }) +
          event({ id: "503", recurrence: ["600", "701"] }) +
          event({ id: "503", recurrence: ["600", "702"] }),
      ),
    );
    expect(
      r.observations.map((x) => [x.sourceEventId, x.sourceSeriesId, x.sourceOccurrenceId]),
    ).toEqual([
      ["501", undefined, undefined],
      ["502", undefined, undefined],
      ["503", "600", "701"],
      ["503", "600", "702"],
    ]);
  });
  it.each([
    event({ title: "Changed" }),
    event({ dates: date("start", "2026-10-25T18:30+05:00") }),
    event({ dates: "" }),

    event({
      extra:
        '<a data-role="activity-link" data-activity-id="202" href="/mod/assign/view.php?id=303">A</a>',
    }),
  ])("moves all conflicting facts into review", (other) => {
    const r = collectMoodleCalendar([input(), input(page(other)), input()], ["101"], observed);
    expect(r.observations).toEqual([]);
    expect(r.review).toHaveLength(2);
    expect(r.review.every((x) => x.reasons.includes("event_conflict"))).toBe(true);
    expect(r.pages.map((x) => x.coverage)).toEqual(["partial", "partial", "partial"]);
  });
  it("deduplicates review candidates and merges fixed reasons", () => {
    const html = page(event({ course: null, dates: "" }));
    const r = collectMoodleCalendar([input(html), input(html)], ["101"], observed);
    expect(r.review).toHaveLength(1);
    expect(r.review[0].reasons).toEqual(["missing_course", "missing_dates"]);
  });
});
describe("bounded supplied coverage and actual access gate (AC5)", () => {
  it("returns inclusive supplied range only", () => {
    const r = collect();
    expect(r.scope).toBe("supplied_ranges_only");
    expect(r.pages[0]).toMatchObject({
      range: { start: "2026-10-01", end: "2026-10-31" },
      candidateCount: 1,
      paginationPending: false,
      coverage: "complete",
    });
  });
  it.each(["data-incomplete", "data-truncated"])("reports %s partial", (attr) => {
    expect(collect(page(event(), "", attr)).coverage).toBe("partial");
  });
  it.each(['<a href="https://evil.invalid/private">Next</a>', "<button>Next</button>"])(
    "signals pending without following controls",
    (control) => {
      const r = collect(page(event(), `<nav data-region="calendar-pagination">${control}</nav>`));
      expect(r.pages[0].paginationPending).toBe(true);
      expect(r.coverage).toBe("partial");
    },
  );
  it("requires explicit empty plus authentic access proof", () => {
    expect(collect(page("", '<p data-role="calendar-empty">None</p>')).coverage).toBe("complete");
    expect(collect(page("")).coverage).toBe("partial");
    expect(
      collect(page("", '<p data-role="calendar-empty">None</p>').replace(account, "")).pages[0]
        .access.status,
    ).toBe("unknown");
    expect(collect(page(event(), '<p data-role="calendar-empty">None</p>')).coverage).toBe(
      "partial",
    );
  });
  it.each([
    ['data-range-start="2026-10-01"', 'data-range-start="2026-02-30"'],
    ['data-range-end="2026-10-31"', 'data-range-end="2026-09-30"'],
    ["<h1>Calendar</h1>", "<h1> </h1>"],
  ])("invalid ranges/main have no coverage", (from, to) => {
    expect(collect(page().replace(from, to)).coverage).toBe("none");
  });
  it("mixed inaccessible and valid pages retain partial coverage", () => {
    const r = collectMoodleCalendar([input(), input(login)], ["101"], observed);
    expect(r.coverage).toBe("partial");
    expect(r.pages[1].access.status).toBe("signed_out");
    expect(r.observations).toHaveLength(1);
  });
  it.each([
    input(login),
    input(denied, { httpStatus: 403 }),
    input("", { networkFailure: true }),
    input(page().replace(account, "")),
  ])("preserves real #10 outcomes on invalid batch args", (i) => {
    const r = collectMoodleCalendar([i], ["bad"], "bad");
    expect(r.observations).toEqual([]);
    expect(r.pages[0].access.status).not.toBe("accessible");
    expect(r.error).toBe("invalid_batch_arguments");
  });
  it("empty batch has no coverage", () => {
    expect(collectMoodleCalendar([], [], observed).coverage).toBe("none");
  });
  it("fact-only #4 calendar is a negative input", () => {
    const r = collect(
      readFileSync(resolve(process.cwd(), "../tests/fixtures/moodle/calendar.html"), "utf8"),
    );
    expect(r.observations).toEqual([]);
    expect(r.coverage).toBe("none");
  });
});
describe("malformed input, dates and privacy", () => {
  it.each([
    "2026-02-30T10:00:00Z",
    "2026-10-25T24:00:00Z",
    "2026-10-25T18:60:00Z",
    "2026-10-25T18:30:60Z",
    "2026-10-25T18:30:00+24:00",
    "2026-10-25T18:30:00+05:60",
    "2026-10-25T18:30:00.1234Z",
    "2026-10-25T18:30:00",
    "2026-10-25",
  ])("rejects invalid exact observedAt %s", (v) => {
    expect(collectMoodleCalendar([input()], ["101"], v).error).toBe("invalid_batch_arguments");
  });
  it.each([
    "2026-02-30T10:00:00Z",
    "2026-10-25T24:00:00Z",
    "2026-10-25T18:60:00Z",
    "2026-10-25T18:30:60Z",
    "2026-10-25T18:30:00+24:00",
    "2026-10-25T18:30:00+05:60",
    "2026-10-25T18:30:00.1234Z",
    "2026-10-25T18:30:00",
  ])("rejects invalid event clock %s", (v) => {
    expect(collect(page(event({ dates: date("start", v) }))).diagnostics[0].reason).toBe(
      "malformed_record",
    );
  });
  it.each(["+05:00", "-03", "UTC+5", "GMT-3", "Bad/Zone", " Asia/Almaty"])(
    "rejects invalid/non-IANA zone %s",
    (tz) => {
      expect(
        collect(page(event({ dates: date("start", undefined, `data-timezone="${tz}"`) })))
          .observations,
      ).toEqual([]);
    },
  );
  it.each([
    date("date", "2026-02-29", ""),
    date("date", "2026-10-25T18:30:00Z"),
    date() + date(),
    date() + date("date", "2026-10-25", ""),
    date("start", "2026-10-26T18:30:00Z") + date("end", "2026-10-25T18:30:00Z"),
    '<div data-date-field="start">No</div>',
    date("unsupported"),
    date("start", undefined, ""),
  ])("rejects malformed date structures", (dates) => {
    expect(collect(page(event({ dates }))).diagnostics[0].reason).toBe("malformed_record");
  });
  it.each([
    "https://evil.invalid/calendar/view.php?event=501",
    "//moodle.sdu.edu.kz/calendar/view.php?event=501",
    "https://user:secret@moodle.sdu.edu.kz/calendar/view.php?event=501",
    "/calendar/view.php?event=0501",
    "/calendar/view.php?event=502",
    "/calendar/view.php?event=501&event=501",
    "/calendar/view.php?event=501#x",
    "/calendar/view.php?%65vent=501",
    "/calendar/view.php?event=501&private=secret",
    "https://moodle.sdu.edu.kz:444/calendar/view.php?event=501",
    " /calendar/view.php?event=501",
    "/calendar\\view.php?event=501",
  ])("rejects unsafe event links %s", (url) => {
    expect(
      collect(page(event()).replace("/calendar/view.php?event=501", url)).observations,
    ).toEqual([]);
  });
  it.each([
    event({ id: "01" }),
    event({ recurrence: ["1", "0"] }),
    event().replace('data-event-id="501"', 'data-event-id="501" data-occurrence-id="7"'),
    event({ extra: '<a data-role="activity-link" href="/mod/assign/view.php?id=303">A</a>' }),
    event({ extra: '<span data-activity-id="202"></span>' }),
    event().replace(
      'href="/course/view.php?id=101"',
      'href="https://evil.invalid/course/view.php?id=101"',
    ),
    event({ extra: event({ id: "502" }) }),
    "<article><h2>Unknown</h2></article>",
  ])("keeps valid siblings when records malformed", (bad) => {
    const r = collect(page(event() + bad));
    expect(r.observations).toHaveLength(1);
    expect(r.coverage).toBe("partial");
    expect(r.diagnostics.every((x) => x.reason === "malformed_record")).toBe(true);
  });
  it.each([
    `${origin}/calendar/view.php?event=501`,
    `${origin}/calendar/view.php#private`,
    `${origin}/course/view.php?id=101`,
  ])("rejects noncanonical page routes %s", (url) => {
    const r = collectMoodleCalendar(
      [input(page(), { requestedUrl: url, finalUrl: url })],
      ["101"],
      observed,
    );
    expect(r.coverage).toBe("none");
  });
  it("fixed diagnostics never reflect private source, URLs, grades or exceptions", () => {
    const r = collect(
      page(
        event({
          title: "Private grade 99",
          extra:
            '<a data-role="activity-link" href="https://secret:password@evil.invalid/private">Secret</a>',
        }),
      ),
    );
    expect(JSON.stringify(r.diagnostics)).toBe(
      '[{"reason":"malformed_record","pageIndex":0,"recordIndex":0}]',
    );
  });
  it("does not mutate DOM/inputs or produce network/storage/log effects, outputs detached", () => {
    const i = input(),
      before = i.document.documentElement.outerHTML,
      selection = Object.freeze(["101"]);
    Object.freeze(i);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected"));
    const log = vi.spyOn(console, "log");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    try {
      const r = collectMoodleCalendar(Object.freeze([i]), selection, observed);
      r.observations[0].title = "changed";
      r.observations[0].start!.value = { kind: "unknown" };
      expect(i.document.documentElement.outerHTML).toBe(before);
      expect(collectMoodleCalendar([i], selection, observed).observations[0].title).toBe(
        "Fictional assessment",
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      log.mockRestore();
      storage.mockRestore();
    }
  });
});

describe("conflict precedence preserves exclusion privacy", () => {
  it.each(["site", "personal", "other", "assessment"])(
    "conflicting excluded %s facts suppress selected tuple",
    (kind) => {
      const excluded = event({
        kind,
        course: "999",
        title: "EXCLUDED PRIVATE TITLE",
        dates: date("start", "2026-10-29T20:22:11Z"),
      });
      const r = collectMoodleCalendar([input(), input(page(excluded))], ["101"], observed);
      expect(r.observations).toEqual([]);
      expect(r.review).toHaveLength(1);
      expect(r.review[0].candidate.title).toBe("Fictional assessment");
      expect(r.review[0].reasons).toContain("event_conflict");
      expect(r.pages.map((p) => p.coverage)).toEqual(["partial", "partial"]);
      expect(JSON.stringify(r)).not.toContain("EXCLUDED PRIVATE TITLE");
      expect(JSON.stringify(r)).not.toContain("20:22:11");
      expect(r.exclusions[0].reason).toBe(
        kind === "assessment"
          ? "unselected_course"
          : kind === "other"
            ? "non_assessment"
            : kind === "site"
              ? "site_event"
              : "personal_event",
      );
    },
  );
  it("excluded-only contradiction marks partial without review leakage", () => {
    const r = collectMoodleCalendar(
      [
        input(page(event({ kind: "site", title: "EXCLUDED SECRET" }))),
        input(page(event({ kind: "personal", title: "EXCLUDED OTHER" }))),
      ],
      ["101"],
      observed,
    );
    expect(r.review).toEqual([]);
    expect(r.observations).toEqual([]);
    expect(r.exclusions).toHaveLength(2);
    expect(r.pages.every((p) => p.coverage === "partial")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("EXCLUDED");
  });
  it("unreliable course review gains conflict without excluded raw facts", () => {
    const r = collectMoodleCalendar(
      [
        input(page(event({ course: null }))),
        input(page(event({ kind: "site", title: "EXCLUDED SECRET" }))),
      ],
      ["101"],
      observed,
    );
    expect(r.review[0].reasons).toEqual(["missing_course", "event_conflict"]);
    expect(JSON.stringify(r)).not.toContain("EXCLUDED");
  });
});
