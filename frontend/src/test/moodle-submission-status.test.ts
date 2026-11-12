import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMoodleSubmissionStatus,
  RECOGNISED_SUBMISSION_CELLS,
  type SubmissionStatusInput,
  type SubmissionStatusObservation,
  type SubmissionStatusResult,
} from "../../../extension/src/moodle-submission-status";
import {
  disabledRegistry,
  liveRegistry,
  syntheticFixtureRegistry,
} from "../../../extension/src/page-refresh";
import { SubmissionStatus } from "../domain/types";

const origin = "https://moodle.sdu.edu.kz";
const observedAt = "2026-11-02T10:15:00+05:00";
const root = resolve(__dirname, "../../..");
const fixtureDir = resolve(root, "tests/fixtures/moodle");
/** Checkouts may use CRLF; the derived inputs below are written with LF. */
const read = (path: string) =>
  readFileSync(resolve(fixtureDir, path), "utf8").replace(/\r\n/g, "\n");
const submitted = read("observed/assign-submitted.html");
const notSubmitted = read("observed/assign-not-submitted.html");
const draft = read("upstream/assign-draft.html");
const reopened = read("upstream/assign-reopened.html");
const notFound = read("observed/not-found.html");
const loginRedirect = JSON.parse(read("observed/login-redirect-course.json")) as {
  response: { status: number; finalPath: string };
};
const urlFor = (cmid: string) => `${origin}/mod/assign/view.php?id=${cmid}`;
const cmidOf = (html: string) => /cmid-(\d+)/.exec(html)![1]!;

type Overrides = Partial<SubmissionStatusInput>;
/** The scan's request: the fixture's cmid (or 990101) in course 9001, unless overridden. */
function input(html: string, overrides: Overrides = {}): SubmissionStatusInput {
  const cmid = /cmid-(\d+)/.exec(html)?.[1] ?? "990101";
  const url = urlFor(cmid);
  return {
    expectedSourceCourseId: "9001",
    expectedSourceCourseModuleId: cmid,
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: url,
    finalUrl: url,
    httpStatus: 200,
    networkFailure: false,
    contentType: "text/html; charset=utf-8",
    ...overrides,
  };
}
const parse = (html: string, overrides: Overrides = {}, at = observedAt) =>
  parseMoodleSubmissionStatus(input(html, overrides), at);
function observation(result: SubmissionStatusResult): SubmissionStatusObservation {
  expect(result.status).toBe("observed");
  return (result as Extract<SubmissionStatusResult, { status: "observed" }>).observation;
}
const observe = (html: string, overrides: Overrides = {}) => observation(parse(html, overrides));
/** Derives a test input from a fixture by replacing one substring that must exist exactly once. */
function variantOf(html: string, from: string, to: string): string {
  expect(html.split(from)).toHaveLength(2);
  return html.replace(from, to);
}
const submittedCell = '<td class="submissionstatussubmitted">Submitted for grading</td>';
const notSubmittedCell = "<td>No submissions have been made yet</td>";
const withCell = (cell: string) => variantOf(submitted, submittedCell, cell);

const states = [
  [
    "observed/assign-submitted.html",
    submitted,
    "submitted",
    "Submitted for grading",
    "observed-sdu",
  ],
  [
    "observed/assign-not-submitted.html",
    notSubmitted,
    "not_submitted",
    "No submissions have been made yet",
    "observed-sdu",
  ],
  [
    "upstream/assign-draft.html",
    draft,
    "draft",
    "Draft (not submitted)",
    "upstream-not-seen-on-sdu",
  ],
  ["upstream/assign-reopened.html", reopened, "reopened", "Reopened", "upstream-not-seen-on-sdu"],
] as const;

/** Inputs derived from observed/assign-submitted.html that must map to unknown. */
const unknownInputs: [string, string][] = [
  [
    "upstream 'Graded' (submissionstatusmarked)",
    withCell('<td class="submissionstatusmarked">Graded</td>'),
  ],
  [
    "Russian wording in a submitted cell",
    withCell('<td class="submissionstatussubmitted">Отправлено для оценивания</td>'),
  ],
  ["body language class lang-ru", variantOf(submitted, "lang-en", "lang-ru")],
  ["body language class lang-kk", variantOf(submitted, "lang-en", "lang-kk")],
  ["<html lang> is ru", variantOf(submitted, '<html lang="en">', '<html lang="ru">')],
  ["no <html lang>", variantOf(submitted, '<html lang="en">', "<html>")],
  [
    "no Submission status row",
    variantOf(submitted, `<tr><th>Submission status</th>${submittedCell}</tr>\n`, ""),
  ],
  [
    "draft class with submitted text",
    withCell('<td class="submissionstatusdraft">Submitted for grading</td>'),
  ],
  [
    "not-submitted text in a classed cell",
    withCell('<td class="submissionstatussubmitted">No submissions have been made yet</td>'),
  ],
  [
    "not-submitted text in a new-state cell",
    withCell('<td class="submissionstatusnew">No submissions have been made yet</td>'),
  ],
  [
    "two conflicting status rows",
    variantOf(
      submitted,
      `<tr><th>Submission status</th>${submittedCell}</tr>`,
      `<tr><th>Submission status</th>${submittedCell}</tr>\n<tr><th>Submission status</th><td class="submissionstatusdraft">Draft (not submitted)</td></tr>`,
    ),
  ],
  [
    "two status classes on one cell",
    withCell(
      '<td class="submissionstatussubmitted submissionstatusdraft">Submitted for grading</td>',
    ),
  ],
  ["empty status cell", withCell('<td class="submissionstatussubmitted"></td>')],
  ["'Reopened' without the reopened class", withCell("<td>Reopened</td>")],
  ["upstream 'Draft' wording only", withCell('<td class="submissionstatusdraft">Draft</td>')],
  [
    "team 'Nothing submitted' wording",
    withCell("<td>Nothing has been submitted for this assignment</td>"),
  ],
  [
    "page without the assignment body id",
    variantOf(submitted, 'id="page-mod-assign-view"', 'id="page-site-index"'),
  ],
  ["no course class", variantOf(submitted, " course-9001", "")],
  ["empty document", ""],
];

describe("#16 evidence registry", () => {
  it("lists only the observed and cited upstream cells", () => {
    expect(
      RECOGNISED_SUBMISSION_CELLS.map((c) => [c.state, c.cellClass, c.wording, c.evidenceBasis]),
    ).toEqual([
      ["submitted", "submissionstatussubmitted", "Submitted for grading", "observed-sdu"],
      ["not_submitted", null, "No submissions have been made yet", "observed-sdu"],
      ["draft", "submissionstatusdraft", "Draft (not submitted)", "upstream-not-seen-on-sdu"],
      ["reopened", "submissionstatusreopened", "Reopened", "upstream-not-seen-on-sdu"],
    ]);
    expect(Object.isFrozen(RECOGNISED_SUBMISSION_CELLS)).toBe(true);
  });
  it("upstream cells match their manifest citation and label", () => {
    const manifest = JSON.parse(read("manifest.json")) as {
      fixtures: {
        path: string;
        sourceKind: string;
        label?: string;
        citation?: { cellClass: string } & Record<string, unknown>;
      }[];
    };
    for (const [path, key] of [
      ["upstream/assign-draft.html", "submissionstatus_draft"],
      ["upstream/assign-reopened.html", "submissionstatus_reopened"],
    ] as const) {
      const entry = manifest.fixtures.find((f) => f.path === path)!;
      const cell = RECOGNISED_SUBMISSION_CELLS.find(
        (c) => c.cellClass === entry.citation!.cellClass,
      )!;
      expect(entry).toMatchObject({
        sourceKind: "upstream-string",
        label: "upstream, not seen on SDU",
        citation: {
          repository: "moodle/moodle",
          branch: "MOODLE_405_STABLE",
          commit: "c0690bbc765fccacd4956452cbff3f6aacad77c5",
          stringKey: key,
          string: cell.wording,
          citedDate: "2026-11-02",
        },
      });
      expect(cell.evidenceBasis).toBe("upstream-not-seen-on-sdu");
    }
  });
  it("#94: only the live Sync all registry collects submission status; synthetic and disabled stay unavailable", () => {
    const dir = resolve(root, "extension/src");
    for (const file of readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && f !== "moodle-submission-status.ts" && f !== "page-refresh.ts",
    ))
      expect(readFileSync(resolve(dir, file), "utf8")).not.toContain("moodle-submission-status");
    expect(liveRegistry().submission).toMatchObject({
      availability: "available",
      evidenceMode: "verified",
    });
    for (const registry of [syntheticFixtureRegistry(), disabledRegistry()])
      expect(registry.submission.availability).toBe("unavailable");
  });
});

describe("AC1: distinct normalized states with source wording", () => {
  it.each(states)(
    "%s maps to its state with scoped wording and evidence basis",
    (_p, html, state, wording, basis) => {
      const cmid = cmidOf(html);
      expect(observe(html)).toEqual({
        state,
        wording,
        evidenceBasis: basis,
        actionRequired: state === "reopened",
        observedAt,
        sourceUrl: urlFor(cmid),
        sourceCourseId: "9001",
        sourceCourseModuleId: cmid,
        access: { status: "unknown", reason: "ambiguous_content" },
      });
    },
  );
  it.each(unknownInputs)("%s maps to unknown with no page wording", (_name, html) => {
    const result = observe(html, { requestedUrl: urlFor("990101"), finalUrl: urlFor("990101") });
    expect(result.state).toBe("unknown");
    expect(result.actionRequired).toBe(false);
    expect(result.wording).toBeUndefined();
    expect(result.evidenceBasis).toBeUndefined();
    expect(result.unknownReason).toEqual(expect.any(String));
    expect(result).toMatchObject({
      observedAt,
      sourceUrl: urlFor("990101"),
      sourceCourseModuleId: "990101",
    });
  });
  it("unknown inputs carry the expected fixed reasons", () => {
    const reason = (html: string) => observe(html).unknownReason;
    expect(reason(unknownInputs[0]![1])).toBe("unrecognised_status");
    expect(reason(unknownInputs[1]![1])).toBe("unrecognised_status");
    expect(reason(unknownInputs[2]![1])).toBe("unsupported_language");
    expect(reason(unknownInputs[4]![1])).toBe("unsupported_language");
    expect(reason(unknownInputs[6]![1])).toBe("missing_status_row");
    expect(reason(unknownInputs[7]![1])).toBe("class_text_mismatch");
    expect(reason(unknownInputs[8]![1])).toBe("class_text_mismatch");
    expect(reason(unknownInputs[10]![1])).toBe("conflicting_status_rows");
  });
  it("two identical status rows are still not a single explicit status", () => {
    const row = `<tr><th>Submission status</th>${submittedCell}</tr>`;
    expect(observe(variantOf(submitted, row, row + row))).toMatchObject({
      state: "unknown",
      unknownReason: "conflicting_status_rows",
    });
  });
  it("normalises whitespace in the class-matched cell text only", () => {
    const html = withCell(
      '<td class="submissionstatussubmitted">\n  Submitted   for\tgrading </td>',
    );
    expect(observe(html)).toMatchObject({ state: "submitted", wording: "Submitted for grading" });
    expect(
      observe(withCell('<td class="submissionstatussubmitted">submitted for grading</td>')).state,
    ).toBe("unknown");
  });
  it("the five states are pairwise distinct and exactly the #5 SubmissionStatus enum", () => {
    const produced = [
      ...states.map(([, html]) => observe(html).state),
      observe(unknownInputs[0]![1]).state,
    ];
    expect(new Set(produced).size).toBe(5);
    expect([...produced].sort()).toEqual([...SubmissionStatus.options].sort());
    const python = readFileSync(resolve(root, "backend/schemas.py"), "utf8");
    const literal = /^SubmissionStatus = Literal\[(.*)\]$/m.exec(python)![1]!;
    expect(literal.split(",").map((s) => s.trim().replace(/^"|"$/g, ""))).toEqual(
      SubmissionStatus.options,
    );
  });
});

describe("AC2: grade and personal completion never change Moodle status", () => {
  const gradingRow = '<tr><th>Grading status</th><td class="submissiongraded">Graded</td></tr>';
  const timeRow =
    '<tr><th>Time remaining</th><td class="timeremaining">1 day 17 hours remaining</td></tr>';
  it("not submitted with a Graded grading status or a grade row stays not_submitted", () => {
    const graded = variantOf(notSubmitted, timeRow, gradingRow + "\n" + timeRow);
    expect(observe(graded)).toMatchObject({ state: "not_submitted", actionRequired: false });
    const gradeRow = variantOf(
      notSubmitted,
      timeRow,
      timeRow + "\n<tr><th>Grade</th><td>[not retained]</td></tr>",
    );
    expect(observe(gradeRow)).toMatchObject({ state: "not_submitted" });
    const feedback =
      '<div class="feedback"><h3>Feedback</h3><table class="generaltable"><tbody><tr><th>Grade</th><td>[not retained]</td></tr><tr><th>Graded on</th><td>Friday, 3 March 2028, 10:59 AM</td></tr></tbody></table></div>\n';
    expect(observe(variantOf(notSubmitted, "</body>", feedback + "</body>"))).toMatchObject({
      state: "not_submitted",
    });
  });
  it("a grade row without a Submission status row is unknown, never submitted", () => {
    const html = variantOf(
      submitted,
      `<tr><th>Submission status</th>${submittedCell}</tr>`,
      "<tr><th>Grade</th><td>[not retained]</td></tr>",
    );
    expect(observe(html)).toMatchObject({ state: "unknown", unknownReason: "missing_status_row" });
  });
  const completion = (checked: boolean) =>
    '<div data-region="activity-information" class="activity-information"><div class="completion-info">' +
    `<button class="btn btn-sm ${checked ? "btn-success" : "btn-outline-secondary"}" data-action="toggle-manual-completion" ` +
    `data-toggletype="${checked ? "manual:undo" : "manual:mark-done"}" aria-pressed="${checked}">${checked ? "Done" : "Mark as done"}</button>` +
    `<input type="checkbox" class="completion-checkbox" ${checked ? "checked" : ""}>` +
    "</div></div>\n";
  it.each(states)("%s with a checked or unchecked completion control is deep-equal", (_p, html) => {
    const plain = parse(html);
    for (const checked of [true, false]) {
      expect(
        parse(
          variantOf(
            html,
            '<div class="submissionstatustable">',
            completion(checked) + '<div class="submissionstatustable">',
          ),
        ),
      ).toEqual(plain);
    }
  });
  it("an unknown input with a completion control is deep-equal too", () => {
    const html = unknownInputs[0]![1];
    expect(parse(variantOf(html, "<h2>", completion(true) + "<h2>"))).toEqual(parse(html));
  });
  it("the public function takes no grade or completion argument and returns no such field", () => {
    expect(parseMoodleSubmissionStatus.length).toBe(2);
    for (const [, html] of states) {
      const keys = Object.keys(observe(html)).join(" ");
      expect(keys).not.toMatch(/grade|grading|completion|done/i);
    }
  });
});

describe("AC3: reopened is flagged for action only on explicit evidence", () => {
  it("upstream reopened fixture requires action", () => {
    expect(observe(reopened)).toMatchObject({ state: "reopened", actionRequired: true });
  });
  it("submitted, not-submitted, draft and every unknown input do not", () => {
    for (const html of [submitted, notSubmitted, draft, ...unknownInputs.map(([, h]) => h)])
      expect(observe(html).actionRequired).toBe(false);
  });
  const words = ["Reopened", "resubmit", "new attempt"];
  it.each([
    ["observed/assign-submitted.html", submitted, "submitted"],
    ["observed/assign-not-submitted.html", notSubmitted, "not_submitted"],
  ] as const)("%s with reopened prose elsewhere keeps its state", (_p, html, state) => {
    for (const word of words) {
      const variants = [
        variantOf(html, "</title>", ` ${word}</title>`),
        variantOf(html, "</h2>", ` ${word}</h2>`),
        variantOf(
          html,
          "</h2>",
          `</h2>\n<div class="box generalbox" id="intro"><p>Please ${word} if asked.</p></div>`,
        ),
        variantOf(html, "Comments (0)", `Comments (1): ${word}`),
        state === "submitted"
          ? variantOf(html, "Not graded", `Not graded (${word})`)
          : variantOf(
              html,
              "<tr><th>Time remaining",
              `<tr><th>Grading status</th><td>${word}</td></tr>\n<tr><th>Time remaining`,
            ),
      ];
      for (const variant of variants)
        expect(observe(variant)).toMatchObject({ state, actionRequired: false });
    }
  });
  it("'Reopened' without the reopened class is unknown and needs no action", () => {
    for (const cell of [
      "<td>Reopened</td>",
      '<td class="submissionstatussubmitted">Reopened</td>',
    ]) {
      expect(observe(withCell(cell))).toMatchObject({ state: "unknown", actionRequired: false });
    }
  });
});

describe("AC4: inaccessible status pages stay unknown", () => {
  const url = urlFor("990101");
  const loginHtml =
    '<!doctype html><html lang="ru"><body id="page-login-index" class="lang-ru"><form></form></body></html>';
  const cases: [string, SubmissionStatusInput, string][] = [
    [
      "observed/login-redirect-course.json (login page, lang-ru)",
      input(loginHtml, {
        requestedUrl: url,
        finalUrl: origin + loginRedirect.response.finalPath,
        httpStatus: loginRedirect.response.status,
      }),
      "ambiguous_content",
    ],
    [
      "observed/not-found.html (HTTP 404)",
      input(notFound, { requestedUrl: url, finalUrl: url, httpStatus: 404 }),
      "unsupported_response",
    ],
    ["HTTP 403 denied", input(submitted, { httpStatus: 403 }), "denied"],
    [
      "network failure",
      input("", { requestedUrl: url, finalUrl: url, networkFailure: true, httpStatus: 0 }),
      "network_failure",
    ],
    ["HTTP 401", input(submitted, { httpStatus: 401 }), "login"],
    ["HTTP 503", input(submitted, { httpStatus: 503 }), "transient_response"],
    [
      "non-HTML response",
      input(submitted, { contentType: "application/json" }),
      "unsupported_response",
    ],
  ];
  it.each(cases)(
    "%s is unknown and carries the detectMoodleAccess reason",
    (_name, value, reason) => {
      const result = observation(parseMoodleSubmissionStatus(value, observedAt));
      expect(result).toEqual({
        state: "unknown",
        unknownReason: "inaccessible",
        actionRequired: false,
        observedAt,
        sourceUrl: url,
        sourceCourseId: "9001",
        sourceCourseModuleId: "990101",
        access: expect.objectContaining({ reason }),
      });
      expect(result.state).not.toBe("not_submitted");
    },
  );
  it("login with a canonical login form also stays unknown with the login reason", () => {
    const form =
      '<!doctype html><html lang="en"><body class="lang-en"><form action="/login/index.php"><input name="username" type="text"><input name="password" type="password"></form></body></html>';
    expect(
      observe(form, { requestedUrl: url, finalUrl: `${origin}/login/index.php`, httpStatus: 200 }),
    ).toMatchObject({ state: "unknown", access: { status: "signed_out", reason: "login" } });
  });
  it("state strings are exactly what backend retain_submission accepts", () => {
    const retention = readFileSync(resolve(root, "backend/submission_retention.py"), "utf8");
    // retain_submission validates states through the #5 SubmissionObservation (SubmissionStatus literal).
    expect(retention).toMatch(/^from backend\.schemas import SubmissionObservation\r?$/m);
    expect(retention).toContain("'unknown'");
    for (const [, html] of [...states, ["", unknownInputs[0]![1]] as const])
      expect(SubmissionStatus.options).toContain(observe(html).state);
  });
});

describe("AC5: observation time and source link", () => {
  it("keeps observedAt character for character, including fraction precision", () => {
    for (const at of [
      "2026-11-02T10:15:00+05:00",
      "2026-11-02T05:15:00.123456789Z",
      "2026-11-02T10:15+05:00",
    ]) {
      expect(observation(parse(submitted, {}, at)).observedAt).toBe(at);
      expect(observation(parse(unknownInputs[0]![1], {}, at)).observedAt).toBe(at);
      expect(observation(parse(submitted, { httpStatus: 403 }, at)).observedAt).toBe(at);
    }
  });
  it.each([
    undefined,
    null,
    "",
    "2026-11-02",
    "2026-11-02T10:15:00",
    "2026-02-30T10:15:00Z",
    "now",
    1730524500000,
  ])("missing or invalid observedAt %s is invalid_observed_at, never the current time", (at) => {
    for (const value of [input(submitted), input(submitted, { httpStatus: 403 })])
      expect(parseMoodleSubmissionStatus(value, at as string)).toEqual({
        status: "error",
        error: "invalid_observed_at",
      });
  });
  it("ids come from the body classes and must equal the URL id", () => {
    expect(observe(notSubmitted)).toMatchObject({
      sourceUrl: urlFor("990102"),
      sourceCourseId: "9001",
      sourceCourseModuleId: "990102",
    });
    expect(
      parse(submitted, { requestedUrl: urlFor("990102"), finalUrl: urlFor("990102") }),
    ).toEqual({
      status: "error",
      error: "identity_mismatch",
    });
    expect(parse(submitted, { finalUrl: urlFor("990102") })).toEqual({
      status: "error",
      error: "identity_mismatch",
    });
    expect(parse(variantOf(submitted, "cmid-990101", "cmid-990101 cmid-990102"))).toEqual({
      status: "error",
      error: "identity_mismatch",
    });
    expect(parse(variantOf(submitted, "course-9001", "course-x9001"))).toEqual({
      status: "error",
      error: "identity_mismatch",
    });
  });
  it("the canonical sourceUrl drops an explicit default port", () => {
    const url = `${origin}:443/mod/assign/view.php?id=990101`;
    expect(observe(submitted, { requestedUrl: url, finalUrl: url }).sourceUrl).toBe(
      urlFor("990101"),
    );
  });
  it.each([
    "http://moodle.sdu.edu.kz/mod/assign/view.php?id=990101",
    "https://moodle.example.invalid/mod/assign/view.php?id=990101",
    "https://user:pw@moodle.sdu.edu.kz/mod/assign/view.php?id=990101",
    "https://moodle.sdu.edu.kz.example.invalid/mod/assign/view.php?id=990101",
    "https://moodle.sdu.edu.kz/mod/assign/view.php?id=990101&action=editsubmission",
    "https://moodle.sdu.edu.kz/mod/assign/view.php?id=990101#x",
    "https://moodle.sdu.edu.kz/mod/assign/view.php?id=0990101",
    "https://moodle.sdu.edu.kz/mod/quiz/view.php?id=990101",
    "https://moodle.sdu.edu.kz:8443/mod/assign/view.php?id=990101",
    "/mod/assign/view.php?id=990101",
  ])("unsafe or non-SDU URL %s is unsafe_url", (url) => {
    expect(parse(submitted, { requestedUrl: url, finalUrl: url })).toEqual({
      status: "error",
      error: "unsafe_url",
    });
  });
  it("an unsafe final URL is unsafe_url", () => {
    expect(
      parse(submitted, {
        finalUrl: "https://moodle.example.invalid/mod/assign/view.php?id=990101",
      }),
    ).toEqual({
      status: "error",
      error: "unsafe_url",
    });
  });
  it("a malformed runtime envelope is a fixed result, never an exception", () => {
    expect(
      parseMoodleSubmissionStatus(null as unknown as SubmissionStatusInput, observedAt),
    ).toEqual({
      status: "error",
      error: "unsafe_url",
    });
    const broken = { ...input(submitted), document: {} as Document };
    expect(observation(parseMoodleSubmissionStatus(broken, observedAt))).toMatchObject({
      state: "unknown",
      sourceCourseModuleId: "990101",
    });
  });
  it("every result carries sourceCourseId: the body class when shown, else the caller's id", () => {
    // Readable pages: from the body class, which equals the expected id.
    for (const [, html] of states) expect(observe(html).sourceCourseId).toBe("9001");
    // A readable page that fails the structure check keeps its body-class course id.
    for (const html of [
      variantOf(submitted, 'id="page-mod-assign-view"', 'id="x"'),
      variantOf(submitted, "cmid-990101 ", ""),
      variantOf(submitted, '<html lang="en">', '<html lang="ru">'),
    ]) {
      expect(observe(html)).toMatchObject({ state: "unknown", sourceCourseId: "9001" });
    }
    // A page with no course class (inaccessible or structure failure) carries the caller's id.
    const noCourse = variantOf(submitted, " course-9001", "");
    expect(observe(noCourse, { expectedSourceCourseId: "9002" })).toMatchObject({
      state: "unknown",
      unknownReason: "missing_structure",
      sourceCourseId: "9002",
    });
    expect(observe(submitted, { httpStatus: 403, expectedSourceCourseId: "9002" })).toMatchObject({
      state: "unknown",
      unknownReason: "inaccessible",
      sourceCourseId: "9002",
    });
    const broken = { ...input(submitted), document: {} as Document };
    expect(observation(parseMoodleSubmissionStatus(broken, observedAt)).sourceCourseId).toBe(
      "9001",
    );
  });
  it("a body course class that differs from the caller's expected id is identity_mismatch", () => {
    expect(parse(submitted, { expectedSourceCourseId: "9002" })).toEqual({
      status: "error",
      error: "identity_mismatch",
    });
    // Also when the page then fails a later structure check.
    expect(
      parse(variantOf(submitted, 'id="page-mod-assign-view"', 'id="x"'), {
        expectedSourceCourseId: "9002",
      }),
    ).toEqual({ status: "error", error: "identity_mismatch" });
  });
  it.each([
    ["expected cmid differs from the requested URL", { expectedSourceCourseModuleId: "990102" }],
    ["expected cmid not a positive decimal", { expectedSourceCourseModuleId: "0990101" }],
    ["expected course id missing", { expectedSourceCourseId: undefined as unknown as string }],
    ["expected course id not a positive decimal", { expectedSourceCourseId: "course-9001" }],
  ])("%s is identity_mismatch, even for an inaccessible page", (_name, overrides) => {
    for (const extra of [{}, { httpStatus: 403 }, { networkFailure: true }])
      expect(parse(submitted, { ...overrides, ...extra })).toEqual({
        status: "error",
        error: "identity_mismatch",
      });
  });
  it.each([
    ["empty", ""],
    ["missing", undefined],
  ])(
    "a network failure with a %s finalUrl is unknown with the access reason, identity from the requested URL",
    (_name, finalUrl) => {
      const value = input("", {
        networkFailure: true,
        httpStatus: 0,
        finalUrl: finalUrl as string,
      });
      expect(observation(parseMoodleSubmissionStatus(value, observedAt))).toEqual({
        state: "unknown",
        unknownReason: "inaccessible",
        actionRequired: false,
        observedAt,
        sourceUrl: urlFor("990101"),
        sourceCourseId: "9001",
        sourceCourseModuleId: "990101",
        access: { status: "unknown", reason: "network_failure" },
      });
      expect(value.finalUrl).toBe(finalUrl);
    },
  );
  it("an empty finalUrl without a network failure is still unsafe_url", () => {
    expect(parse(submitted, { finalUrl: "" })).toEqual({ status: "error", error: "unsafe_url" });
  });
  it("a sentinel in the body, comments and file submissions never appears in any result", () => {
    const sentinel = "SENTINEL-7f3a-private";
    const seed = (html: string) =>
      html
        .replace("</h2>", ` ${sentinel}</h2>`)
        .replace("Comments (0)", `Comments (1) ${sentinel}`)
        .replace("</body>", `<p>${sentinel}</p></body>`)
        .replace(
          /<tr><th>File submissions<\/th><td>\[not retained\]<\/td><\/tr>/,
          `<tr><th>File submissions</th><td>${sentinel}.pdf</td></tr>`,
        )
        .replace(
          "<tr><th>Submission comments",
          `<tr><th>File submissions</th><td>${sentinel}.docx</td></tr>\n<tr><th>Submission comments`,
        );
    const htmls = [...states.map(([, h]) => h), ...unknownInputs.map(([, h]) => h).filter(Boolean)];
    for (const html of htmls) {
      const seeded = seed(html);
      expect(seeded).toContain(sentinel);
      for (const overrides of [{}, { httpStatus: 403 }, { networkFailure: true }]) {
        const result = JSON.stringify(
          parseMoodleSubmissionStatus(input(seeded, overrides), observedAt),
        );
        expect(result).not.toContain(sentinel);
      }
    }
    // A sentinel inside an unrecognised status cell is not echoed either.
    expect(
      JSON.stringify(parse(withCell(`<td class="submissionstatussubmitted">${sentinel}</td>`))),
    ).not.toContain(sentinel);
  });
  it("leaves the input DOM unchanged and returns detached results", () => {
    for (const [, html] of states) {
      const value = input(html);
      const before = value.document.documentElement.outerHTML;
      const first = observe(html);
      parseMoodleSubmissionStatus(value, observedAt);
      expect(value.document.documentElement.outerHTML).toBe(before);
      const again = observation(parseMoodleSubmissionStatus(value, observedAt));
      again.access.reason = "accessible";
      expect(observation(parseMoodleSubmissionStatus(value, observedAt))).toEqual(first);
    }
  });
});

describe("#94: the live Sync all collector", () => {
  /** The scan's envelope for one fetched assignment page: no expected ids, which the collector derives. */
  const envelope = (html: string, cmid = cmidOf(html)) => {
    const {
      expectedSourceCourseId: _c,
      expectedSourceCourseModuleId: _m,
      ...rest
    } = input(html, {
      requestedUrl: urlFor(cmid),
      finalUrl: urlFor(cmid),
    });
    return rest;
  };
  const collect = (html: string, selection: string[] = ["9001"], cmid?: string) =>
    liveRegistry().submission.collect(envelope(html, cmid), selection, observedAt, {
      title: "Fictional title",
    });
  it.each(states)(
    "%s: module-keyed result from the scan's course and requested cmid",
    async (_p, html, state, wording) => {
      const cmid = cmidOf(html);
      expect(await collect(html)).toEqual({
        kind: "submission",
        observations: [
          {
            sourceCourseId: "9001",
            sourceCourseModuleId: cmid,
            sourceUrl: urlFor(cmid),
            observation: {
              status: state,
              evidence: wording,
              observedAt,
              actionRequired: state === "reopened",
            },
          },
        ],
        reviews: [],
        diagnostics: [],
        pages: [],
        coverage: "complete",
        scope: "visited_activity_only",
      });
    },
  );
  it.each(unknownInputs)("%s stays unknown with no wording", async (_name, html) => {
    const result = await collect(html, ["9001"], "990101");
    expect(result.kind).toBe("submission");
    const [record] = (result as Extract<typeof result, { kind: "submission" }>).observations;
    expect(record!.observation).toEqual({ status: "unknown", observedAt, actionRequired: false });
    expect(record).not.toHaveProperty("sourceActivityId");
  });
  it("never copies the cmid into sourceActivityId and fails on another course", async () => {
    const result = await collect(submitted);
    expect(JSON.stringify(result)).not.toContain("sourceActivityId");
    expect(await collect(submitted, ["9002"])).toEqual({
      kind: "failed",
      reasons: ["identity_mismatch"],
    });
    expect(await collect(submitted, [])).toEqual({
      kind: "failed",
      reasons: ["identity_mismatch"],
    });
  });
});
