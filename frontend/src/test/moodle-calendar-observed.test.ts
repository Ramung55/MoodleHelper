/** #83 AC2/AC5: the calendar collector on the observed SDU upcoming calendar page. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import {
  collectObservedMoodleCalendar,
  observedEpochIso,
  UPCOMING_CALENDAR_URL,
} from "../../../extension/src/moodle-calendar";
import { calendarRefreshResult } from "../../../extension/src/page-refresh";
import { validSchema } from "../../../shared/src/bridge";

const origin = "https://moodle.sdu.edu.kz";
const observedAt = "2028-03-05T10:00:00.000Z";
const dir = resolve(__dirname, "../../../tests/fixtures/moodle/observed");
const upcoming = readFileSync(resolve(dir, "calendar-upcoming.html"), "utf8");
const exact = (iso: string) => ({ kind: "exact", iso, tz: "Asia/Almaty" });

function input(html: string, overrides: Partial<MoodleAccessInput> = {}): MoodleAccessInput {
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: UPCOMING_CALENDAR_URL,
    finalUrl: UPCOMING_CALENDAR_URL,
    httpStatus: 200,
    networkFailure: false,
    contentType: "text/html; charset=utf-8",
    ...overrides,
  };
}
const collect = (
  html: string,
  selection: string[] = ["9001"],
  overrides: Partial<MoodleAccessInput> = {},
) => collectObservedMoodleCalendar(input(html, overrides), selection, observedAt);
/** The fixture with the first event box edited. */
const firstEvent = (change: (box: string) => string) => {
  const start = upcoming.indexOf('<div class="calendar-event-box"'),
    end = upcoming.indexOf('<div class="calendar-event-box"', start + 1);
  return upcoming.slice(0, start) + change(upcoming.slice(start, end)) + upcoming.slice(end);
};

describe("observed/ upcoming calendar (#83 AC2)", () => {
  it("maps only events of selected courses, with exact times from the epoch day link", () => {
    expect(UPCOMING_CALENDAR_URL).toBe(`${origin}/calendar/view.php?view=upcoming`);
    const result = calendarRefreshResult(input(upcoming), ["9001"], observedAt);
    expect(validSchema("CollectorResult", result)).toBe(true);
    expect(result).toEqual({
      kind: "calendar",
      scope: "supplied_ranges_only",
      coverage: "partial",
      reviews: [],
      observations: [
        {
          sourceEventId: "880001",
          sourceCourseId: "9001",
          title: "Fictional Lab Report",
          sourceUrl: `${origin}/calendar/view.php?event=880001`,
          observedAt,
          start: {
            value: exact("2028-03-07T14:30:00+05:00"),
            rawText: "Fictional Lab Report is due",
            location: "calendar.start",
          },
          activity: {
            moduleType: "assign",
            sourceActivityId: "990102",
            sourceCourseModuleId: "990102",
            sourceUrl: `${origin}/mod/assign/view.php?id=990102`,
          },
        },
      ],
      diagnostics: [{ reason: "unselected_course", pageIndex: 0, recordIndex: 1 }],
      pages: [{ coverage: "partial", candidateCount: 2, paginationPending: false }],
    });
    const other = collect(upcoming, ["9002"]);
    expect(other.observations).toEqual([
      expect.objectContaining({
        sourceEventId: "880002",
        sourceCourseId: "9002",
        title: "Fictional Problem Set",
        start: expect.objectContaining({ value: exact("2028-03-14T14:30:00+05:00") }),
        activity: expect.objectContaining({ sourceCourseModuleId: "990201" }),
      }),
    ]);
    expect(other.exclusions).toEqual([
      { reason: "unselected_course", pageIndex: 0, recordIndex: 0 },
    ]);
    const none = collect(upcoming, []);
    expect([none.observations, none.review, none.exclusions.map((e) => e.reason)]).toEqual([
      [],
      [],
      ["unselected_course", "unselected_course"],
    ]);
    expect(observedEpochIso("1836034200")).toBe("2028-03-07T14:30:00+05:00");
    expect(observedEpochIso("1836639000")).toBe("2028-03-14T14:30:00+05:00");
  });

  it("never takes the time from the displayed text and never returns the action link", () => {
    const shown = collect(
      firstEvent((box) =>
        box.replace("Tuesday, 7 March</a>, 2:30 PM", "Friday, 1 January</a>, 9:00 AM"),
      ),
    );
    expect(shown.observations[0]!.start!.value).toEqual(exact("2028-03-07T14:30:00+05:00"));
    expect(JSON.stringify(collect(upcoming))).not.toContain("editsubmission");
  });

  it("checks access: signed out, wrong route or redirected pages give no observations", () => {
    const login = collect(readFileSync(resolve(dir, "login-page.html"), "utf8"));
    expect([login.pages[0]!.access.status, login.observations.length]).toEqual(["signed_out", 0]);
    expect(
      collect(upcoming, ["9001"], { finalUrl: `${origin}/login/index.php` }).pages[0]!.access
        .status,
    ).toBe("signed_out");
    expect(
      collect(upcoming, ["9001"], { finalUrl: `${origin}/calendar/view.php?view=month` }).pages[0]!
        .access.status,
    ).toBe("unknown");
    const month = collectObservedMoodleCalendar(
      input(upcoming, {
        requestedUrl: `${origin}/calendar/view.php?view=month`,
        finalUrl: `${origin}/calendar/view.php?view=month`,
      }),
      ["9001"],
      observedAt,
    );
    expect([month.pages[0]!.access.reason, month.observations.length]).toEqual([
      "unsupported_route",
      0,
    ]);
    expect(
      calendarRefreshResult(input(upcoming, { httpStatus: 503 }), ["9001"], observedAt),
    ).toEqual({ kind: "failed", reasons: ["access_error"] });
  });

  it("sends unobserved event kinds, missing courses and missing epochs to review, never to observations", () => {
    for (const change of [
      (b: string) =>
        b.replace('data-event-component="mod_assign"', 'data-event-component="mod_quiz"'),
      (b: string) => b.replace('data-event-eventtype="due"', 'data-event-eventtype="course"'),
    ]) {
      const r = collect(firstEvent(change));
      expect(r.observations).toEqual([]);
      expect(r.review).toEqual([expect.objectContaining({ reasons: ["unknown_kind"] })]);
    }
    const missingCourse = collect(firstEvent((b) => b.replace(' data-course-id="9001"', "")));
    expect(missingCourse.observations).toEqual([]);
    expect(missingCourse.review).toEqual([
      {
        candidate: expect.not.objectContaining({ sourceCourseId: expect.anything() }),
        reasons: ["missing_course"],
      },
    ]);
    for (const epoch of ["", "soon", "-1"]) {
      const r = collect(firstEvent((b) => b.replace("time=1836034200", `time=${epoch}`)));
      expect(r.observations).toEqual([]);
      expect(r.review).toEqual([
        {
          candidate: expect.not.objectContaining({ start: expect.anything() }),
          reasons: ["missing_dates"],
        },
      ]);
    }
    const noLink = collect(
      firstEvent((b) =>
        b.replace(/<a data-href="\/calendar[^"]*">Tuesday, 7 March<\/a>/, "Tuesday, 7 March"),
      ),
    );
    expect(noLink.review).toEqual([expect.objectContaining({ reasons: ["missing_dates"] })]);
    const result = calendarRefreshResult(
      input(firstEvent((b) => b.replace(' data-course-id="9001"', ""))),
      ["9001"],
      observedAt,
    );
    expect(validSchema("CollectorResult", result)).toBe(true);
  });

  it("marks one event id with different values as event_conflict and keeps identical repeats once", () => {
    const box = upcoming.slice(
      upcoming.indexOf('<div class="calendar-event-box"'),
      upcoming.indexOf(
        '<div class="calendar-event-box"',
        upcoming.indexOf('<div class="calendar-event-box"') + 1,
      ),
    );
    const twice = collect(upcoming.replace("</body>", box + "</body>"));
    expect(twice.observations).toHaveLength(1);
    const conflict = collect(
      upcoming.replace("</body>", box.replace("time=1836034200", "time=1836037800") + "</body>"),
    );
    expect(conflict.observations).toEqual([]);
    expect(conflict.review.map((r) => r.reasons)).toEqual([["event_conflict"], ["event_conflict"]]);
  });

  it("never claims complete coverage, even for an empty upcoming list", () => {
    const empty = collect(
      '<!doctype html><html lang="en"><head></head><body class="lang-en"></body></html>',
    );
    expect([empty.coverage, empty.pages[0]!.coverage, empty.observations]).toEqual([
      "partial",
      "partial",
      [],
    ]);
  });
});

describe("observed/ calendar unobserved variants (#83 AC5)", () => {
  it("RU/KK interfaces give invalid_page and no events", () => {
    for (const html of [
      upcoming.replace("lang-en", "lang-ru"),
      upcoming.replace('lang="en"', 'lang="kk"').replace("lang-en", "lang-kk"),
    ]) {
      const r = collect(html);
      expect([r.observations, r.review, r.diagnostics.map((d) => d.reason), r.coverage]).toEqual([
        [],
        [],
        ["invalid_page"],
        "none",
      ]);
    }
  });
});
