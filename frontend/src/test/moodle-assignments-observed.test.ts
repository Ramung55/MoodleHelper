/** #83 AC1/AC5: the assignment collector on the observed SDU assignment view pages. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import { parseObservedMoodleAssignment } from "../../../extension/src/moodle-assignments";
import { assignmentRefreshResult } from "../../../extension/src/page-refresh";
import { validSchema } from "../../../shared/src/bridge";

const origin = "https://moodle.sdu.edu.kz";
const observedAt = "2028-03-05T10:00:00.000Z";
const dir = resolve(__dirname, "../../../tests/fixtures/moodle/observed");
const read = (name: string) => readFileSync(resolve(dir, name), "utf8");
const submitted = read("assign-submitted.html"),
  notSubmitted = read("assign-not-submitted.html");
const assignUrl = (cmid: string) => `${origin}/mod/assign/view.php?id=${cmid}`;
const exact = (iso: string) => ({ kind: "exact", iso, tz: "Asia/Almaty" });

function input(
  html: string,
  cmid = "990101",
  overrides: Partial<MoodleAccessInput> = {},
): MoodleAccessInput {
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: assignUrl(cmid),
    finalUrl: assignUrl(cmid),
    httpStatus: 200,
    networkFailure: false,
    contentType: "text/html; charset=utf-8",
    ...overrides,
  };
}
const parse = (
  html: string,
  cmid = "990101",
  course = "9001",
  overrides: Partial<MoodleAccessInput> = {},
) => parseObservedMoodleAssignment(input(html, cmid, overrides), observedAt, course);
const reason = (result: ReturnType<typeof parse>) =>
  result.status === "error" ? result.reason : "success";

describe("observed/ assignment view pages (#83 AC1)", () => {
  it("gives the cmid identity, the course id and the exact UTC+5 opening and due dates with their wording", () => {
    const result = assignmentRefreshResult(input(submitted), observedAt, {
      title: "Fictional Essay Outline",
      sourceCourseId: "9001",
    });
    expect(validSchema("CollectorResult", result)).toBe(true);
    const base = {
      opening: {
        value: exact("2028-03-01T00:00:00+05:00"),
        rawText: "Opened: Wednesday, 1 March 2028, 12:00 AM",
        location: "assignment.base.opening",
      },
      due: {
        value: exact("2028-03-08T23:59:00+05:00"),
        rawText: "Due: Wednesday, 8 March 2028, 11:59 PM",
        location: "assignment.base.due",
      },
    };
    expect(result).toEqual({
      kind: "assignment",
      coverage: "complete",
      scope: "visited_activity_only",
      reviews: [],
      diagnostics: [],
      pages: [],
      observations: [
        {
          sourceCourseId: "9001",
          sourceActivityId: "990101",
          sourceCourseModuleId: "990101",
          sourceUrl: assignUrl("990101"),
          title: "Fictional Essay Outline",
          observedAt,
          baseDates: base,
          individualExtensions: [],
          effectiveDates: base,
        },
      ],
    });
    // No submission status, grade or file-submission text is carried.
    expect(JSON.stringify(result)).not.toMatch(
      /Submitted for grading|Not graded|not retained|submission/i,
    );

    const other = assignmentRefreshResult(input(notSubmitted, "990102"), observedAt, {
      title: "Fictional Lab Report",
      sourceCourseId: "9001",
    });
    expect(validSchema("CollectorResult", other)).toBe(true);
    expect(other).toMatchObject({
      kind: "assignment",
      observations: [
        {
          sourceCourseId: "9001",
          sourceCourseModuleId: "990102",
          sourceActivityId: "990102",
          title: "Fictional Lab Report",
          individualExtensions: [],
          baseDates: {
            opening: {
              value: exact("2028-03-01T09:00:00+05:00"),
              rawText: "Opened: Wednesday, 1 March 2028, 9:00 AM",
            },
            due: {
              value: exact("2028-03-07T14:30:00+05:00"),
              rawText: "Due: Tuesday, 7 March 2028, 2:30 PM",
            },
          },
        },
      ],
    });
    const o = (other as { observations: { baseDates: object; effectiveDates: object }[] })
      .observations[0]!;
    expect(o.effectiveDates).toEqual(o.baseDates);
    expect(Object.keys(o.baseDates)).toEqual(["opening", "due"]);
  });

  it("never takes the title from the page h2: without the course-card title it fails with missing_metadata", () => {
    expect(
      assignmentRefreshResult(input(submitted), observedAt, { sourceCourseId: "9001" }),
    ).toEqual({ kind: "failed", reasons: ["missing_metadata"] });
  });

  it("is signed out on the login page and not found on the 404 page", () => {
    const login = parse(read("login-page.html"));
    expect(login.status).toBe("error");
    expect(login.access.status).toBe("signed_out");
    expect(
      parse(submitted, "990101", "9001", { finalUrl: `${origin}/login/index.php` }).access.status,
    ).toBe("signed_out");
    const missing = parse(read("not-found.html"), "990101", "9001", { httpStatus: 404 });
    expect([missing.status, missing.access.status, missing.access.reason]).toEqual([
      "error",
      "unsupported",
      "not_found",
    ]);
  });

  it("gives no observation when the cmid or course class differs from the request or the scanned course", () => {
    expect(reason(parse(submitted, "990102"))).toBe("identity_mismatch");
    expect(reason(parse(submitted, "990101", "9002"))).toBe("identity_mismatch");
    expect(reason(parse(submitted.replace("cmid-990101", "cmid-990101 cmid-990102")))).toBe(
      "identity_mismatch",
    );
    expect(reason(parse(submitted, "990101", "9001", { finalUrl: assignUrl("990102") }))).toBe(
      "access_error",
    );
  });

  it("without the activity dates region the observation has no due date, never a guessed one", () => {
    const html = submitted.replace(/<div data-region="activity-dates">.*?<\/div><\/div>/s, "");
    const result = assignmentRefreshResult(input(html), observedAt, {
      title: "Fictional Essay Outline",
      sourceCourseId: "9001",
    });
    expect(validSchema("CollectorResult", result)).toBe(true);
    expect(result).toMatchObject({
      kind: "assignment",
      observations: [{ baseDates: {}, effectiveDates: {}, individualExtensions: [] }],
    });
  });

  it("rejects two Due rows, keeps a disagreeing weekday with its raw text, and rejects an invalid date", () => {
    expect(
      reason(
        parse(
          submitted.replace(
            "</div></div>",
            "</div><div>Due: Thursday, 9 March 2028, 11:59 PM</div></div>",
          ),
        ),
      ),
    ).toBe("duplicate_date");
    const quirk = parse(submitted.replace("Due: Wednesday, 8 March", "Due: Thursday, 8 March"));
    expect(quirk).toMatchObject({
      status: "success",
      observation: {
        due: {
          value: exact("2028-03-08T23:59:00+05:00"),
          rawText: "Due: Thursday, 8 March 2028, 11:59 PM",
          weekdayMismatch: { shown: "Thursday", computed: "Wednesday" },
        },
      },
    });
    expect(
      reason(parse(submitted.replace("Wednesday, 8 March 2028", "Thursday, 31 February 2028"))),
    ).toBe("invalid_date");
  });
});

describe("observed/ assignment unobserved variants (#83 AC5)", () => {
  const variants: [string, string, string][] = [
    [
      "a Cut-off date row",
      submitted.replace(
        "</div></div>",
        "</div><div>Cut-off date: Friday, 10 March 2028, 11:59 PM</div></div>",
      ),
      "unsupported_date",
    ],
    [
      "an extension notice",
      submitted.replace(
        "<tr><th>Last modified</th>",
        "<tr><th>Extension due date</th><td>Friday, 10 March 2028, 11:59 PM</td></tr><tr><th>Last modified</th>",
      ),
      "unsupported_date",
    ],
    [
      "an override-style date label",
      submitted.replace("Due: Wednesday", "Due (override): Wednesday"),
      "unsupported_date",
    ],
    ["a lang-ru body class", submitted.replace("lang-en", "lang-ru"), "unsupported_structure"],
    [
      "a lang-kk page",
      submitted.replace('lang="en"', 'lang="kk"').replace("lang-en", "lang-kk"),
      "unsupported_structure",
    ],
    [
      "RU date words",
      submitted.replace(
        "Due: Wednesday, 8 March 2028, 11:59 PM",
        "Срок сдачи: среда, 8 марта 2028, 23:59",
      ),
      "unsupported_date",
    ],
  ];
  for (const [name, html, expected] of variants)
    it(`${name} gives ${expected} and no date`, () => {
      const result = assignmentRefreshResult(input(html), observedAt, {
        title: "Fictional Essay Outline",
        sourceCourseId: "9001",
      });
      expect(result).toEqual({ kind: "failed", reasons: [expected] });
    });
});
