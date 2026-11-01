import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import {
  parseMoodleQuizPage,
  parseObservedQuizDate,
  SUPPORTED_QUIZ_VARIANTS,
  supportedQuizVariant,
  type QuizObservation,
  type QuizParseResult,
} from "../../../extension/src/moodle-quizzes";

const origin = "https://moodle.sdu.edu.kz";
const observedAt = "2026-11-01T10:15:00+05:00";
const fixtureDir = resolve(__dirname, "../../../tests/fixtures/moodle");
const observedQuiz = readFileSync(resolve(fixtureDir, "observed/quiz-finished.html"), "utf8");
const observedCourse = readFileSync(resolve(fixtureDir, "observed/course-page.html"), "utf8");
const observedNotFound = readFileSync(resolve(fixtureDir, "observed/not-found.html"), "utf8");
const loginRedirect = JSON.parse(
  readFileSync(resolve(fixtureDir, "observed/login-redirect-course.json"), "utf8"),
) as { response: { status: number; finalPath: string } };
const quizUrl = `${origin}/mod/quiz/view.php?id=990103`,
  courseUrl = `${origin}/course/view.php?id=9001`;

function input(html: string, overrides: Partial<MoodleAccessInput> = {}): MoodleAccessInput {
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: quizUrl,
    finalUrl: quizUrl,
    httpStatus: 200,
    networkFailure: false,
    contentType: "text/html; charset=utf-8",
    ...overrides,
  };
}
const course = (html = observedCourse, overrides: Partial<MoodleAccessInput> = {}) =>
  input(html, { requestedUrl: courseUrl, finalUrl: courseUrl, ...overrides });
function only(result: QuizParseResult): QuizObservation {
  expect(result).toMatchObject({ status: "complete", diagnostics: [] });
  expect(result.observations).toHaveLength(1);
  return result.observations[0]!;
}
/** SYNTHETIC: a variant of the observed quiz page with one substring replaced. */
const variantOf = (from: string, to: string, html = observedQuiz) => {
  expect(html).toContain(from);
  return html.replace(from, to);
};
const closedRow = "<div>Closed: Saturday, 4 March 2028, 9:00 AM</div>";
const quizInfo = /<div class="box quizinfo">[\s\S]*?<\/div>\n/;
const attemptsList = /<div class="rui-attempts-list">[\s\S]*?<\/div>\n<\/div>\n/;
const exhausted = '<div class="box quizattempt">No more attempts are allowed</div>\n';

describe("#14 verified-support registry", () => {
  it("lists only the #3-observed English/alpha variants", () => {
    expect(SUPPORTED_QUIZ_VARIANTS.map((v) => [v.id, v.page, v.language, v.theme])).toEqual([
      ["sdu-en-alpha/quiz-finished-no-attempts-left", "quiz_view", "en", "alpha"],
      ["sdu-en-alpha/course-page-format-topics", "course_quiz_card", "en", "alpha"],
    ]);
    expect(Object.isFrozen(SUPPORTED_QUIZ_VARIANTS)).toBe(true);
    expect(supportedQuizVariant("quiz_view", "ru", "alpha")).toBeUndefined();
    expect(supportedQuizVariant("quiz_view", "en", "boost")).toBeUndefined();
  });
  it("registry ids match the #4 manifest source variants of the observed fixtures", () => {
    const manifest = JSON.parse(readFileSync(resolve(fixtureDir, "manifest.json"), "utf8")) as {
      fixtures: {
        path: string;
        sourceVariant: string;
        sourceKind: string;
        language: string;
        theme?: string;
      }[];
    };
    for (const [id, path] of [
      [SUPPORTED_QUIZ_VARIANTS[0]!.id, "observed/quiz-finished.html"],
      [SUPPORTED_QUIZ_VARIANTS[1]!.id, "observed/course-page.html"],
    ]) {
      expect(manifest.fixtures.find((f) => f.path === path)).toMatchObject({
        sourceVariant: id,
        sourceKind: "observed-structure",
        language: "en",
        theme: "alpha",
      });
    }
  });
  it("is not dispatched by the production page-refresh registries", () => {
    const sources = readdirSync(resolve(__dirname, "../../../extension/src")).filter(
      (f) => f.endsWith(".ts") && f !== "moodle-quizzes.ts",
    );
    for (const file of sources)
      expect(
        readFileSync(resolve(__dirname, "../../../extension/src", file), "utf8"),
      ).not.toContain("moodle-quizzes");
  });
});

describe("#14 observed quiz view page (observed/quiz-finished.html)", () => {
  it("keeps opening and closing separately with source wording, identity and source link", () => {
    const quiz = only(parseMoodleQuizPage(input(observedQuiz), observedAt));
    expect(quiz).toMatchObject({
      variant: "sdu-en-alpha/quiz-finished-no-attempts-left",
      sourceCourseId: "9001",
      sourceCourseModuleId: "990103",
      sourceActivityId: { kind: "unknown" },
      sourceUrl: quizUrl,
      sourcePageUrl: quizUrl,
      title: { kind: "unknown" },
      observedAt,
    });
    expect(quiz.opening).toEqual({
      value: { kind: "exact", iso: "2028-03-02T09:00:00+05:00", tz: "Asia/Almaty" },
      rawText: "Opened: Thursday, 2 March 2028, 9:00 AM",
      label: "Opened:",
      meaning: "quiz_open",
      location: "quiz.opening",
    });
    expect(quiz.closing).toEqual({
      value: { kind: "exact", iso: "2028-03-04T09:00:00+05:00", tz: "Asia/Almaty" },
      rawText: "Closed: Saturday, 4 March 2028, 9:00 AM",
      label: "Closed:",
      meaning: "quiz_close",
      location: "quiz.closing",
    });
  });
  it("labels the closing time as quiz close, never as an exam start", () => {
    const quiz = only(parseMoodleQuizPage(input(observedQuiz), observedAt));
    expect(quiz.close).toBe("quiz_close");
    expect(JSON.stringify(quiz)).not.toMatch(/exam|appointment|start(?!ed)/i);
  });
  it("keeps visible attempt information with its source wording and no derived counts", () => {
    const info = only(parseMoodleQuizPage(input(observedQuiz), observedAt)).attemptInformation;
    expect(info).toEqual({
      kind: "known",
      unknownFields: ["used"],
      facts: [
        {
          field: "allowed",
          label: "Attempts allowed",
          rawText: "Attempts allowed: 1",
          location: "quiz.attemptInformation.allowed",
        },
        {
          field: "other",
          label: "Time limit",
          rawText: "Time limit: 10 mins",
          location: "quiz.attemptInformation.other",
        },
        {
          field: "state",
          label: "Status",
          rawText: "Finished",
          location: "quiz.attemptInformation.state",
          attempt: "Attempt 1",
        },
        {
          field: "other",
          label: "Started",
          rawText: "Friday, 3 March 2028, 10:05 AM",
          location: "quiz.attemptInformation.other",
          attempt: "Attempt 1",
        },
        {
          field: "other",
          label: "Completed",
          rawText: "Friday, 3 March 2028, 10:13 AM",
          location: "quiz.attemptInformation.other",
          attempt: "Attempt 1",
        },
        {
          field: "remaining",
          label: "Attempt summary",
          rawText: "No more attempts are allowed",
          location: "quiz.attemptInformation.remaining",
        },
      ],
    });
  });
  it("never retains marks, grade or the password notice", () => {
    const text = JSON.stringify(parseMoodleQuizPage(input(observedQuiz), observedAt));
    expect(text).not.toMatch(/Marks|Grade|not retained|password|Duration/);
  });
  it("does not mutate the input document", () => {
    const i = input(observedQuiz),
      before = i.document.documentElement.outerHTML;
    parseMoodleQuizPage(i, observedAt);
    expect(i.document.documentElement.outerHTML).toBe(before);
  });
});

describe("#14 observed course page quiz card (observed/course-page.html)", () => {
  it("collects only the quiz card, with dates, identity and source link", () => {
    const result = parseMoodleQuizPage(course(), observedAt);
    expect(result).toMatchObject({
      page: "course_quiz_card",
      variant: "sdu-en-alpha/course-page-format-topics",
    });
    const quiz = only(result);
    expect(quiz).toMatchObject({
      sourceCourseId: "9001",
      sourceCourseModuleId: "990103",
      sourceActivityId: { kind: "unknown" },
      sourceUrl: quizUrl,
      sourcePageUrl: courseUrl,
      title: { kind: "known", value: "Fictional Warm-up Quiz" },
      close: "quiz_close",
      attemptInformation: { kind: "unknown" },
    });
    expect(quiz.opening?.rawText).toBe("Opened: Thursday, 2 March 2028, 9:00 AM");
    expect(quiz.closing).toMatchObject({
      rawText: "Closed: Saturday, 4 March 2028, 9:00 AM",
      meaning: "quiz_close",
      value: { kind: "exact", iso: "2028-03-04T09:00:00+05:00", tz: "Asia/Almaty" },
    });
  });
  it("SYNTHETIC: a broken quiz card is an explicit incomplete diagnostic, not dropped silently", () => {
    const html = variantOf(
      '<a data-href="/mod/quiz/view.php?id=990103">',
      '<a data-href="/mod/quiz/view.php?id=990199">',
      observedCourse,
    );
    expect(parseMoodleQuizPage(course(html), observedAt)).toMatchObject({
      status: "incomplete",
      observations: [],
      diagnostics: [{ reason: "identity_mismatch", index: 0 }],
    });
  });
  it("SYNTHETIC: an off-origin quiz link is unsafe", () => {
    const html = variantOf(
      'data-href="/mod/quiz/view.php?id=990103"',
      'data-href="https://evil.example/mod/quiz/view.php?id=990103"',
      observedCourse,
    );
    expect(parseMoodleQuizPage(course(html), observedAt)).toMatchObject({
      status: "incomplete",
      diagnostics: [{ reason: "unsafe_url" }],
    });
  });
  it("SYNTHETIC: a card without a Closed: row stays open-ended", () => {
    const html = variantOf(closedRow, "", observedCourse);
    expect(html).not.toContain("Closed:");
    const quiz = only(parseMoodleQuizPage(course(html), observedAt));
    expect(quiz.close).toBe("open_ended");
    expect(quiz).not.toHaveProperty("closing");
  });
});

describe("#14 SYNTHETIC variants of the observed structure", () => {
  it("no closing date: stays open-ended and the opening is never used as a deadline", () => {
    const quiz = only(parseMoodleQuizPage(input(variantOf(closedRow, "")), observedAt));
    expect(quiz.close).toBe("open_ended");
    expect(quiz).not.toHaveProperty("closing");
    expect(quiz.opening?.meaning).toBe("quiz_open");
  });
  it("no activity dates at all: no opening, no closing, open-ended", () => {
    const quiz = only(
      parseMoodleQuizPage(
        input(observedQuiz.replace(/<div data-region="activity-dates">.*<\/div><\/div>\n/, "")),
        observedAt,
      ),
    );
    expect(quiz).toMatchObject({ close: "open_ended" });
    expect(quiz).not.toHaveProperty("opening");
  });
  it("absent attempt information stays unknown", () => {
    const html = observedQuiz
      .replace(quizInfo, "")
      .replace(attemptsList, "")
      .replace(exhausted, "");
    expect(html).not.toMatch(/quizinfo|rui-attempts-list|quizattempt/);
    expect(only(parseMoodleQuizPage(input(html), observedAt)).attemptInformation).toEqual({
      kind: "unknown",
    });
  });
  it("partial attempt information keeps observed facts and marks the rest unknown", () => {
    const html = observedQuiz.replace(attemptsList, "").replace(exhausted, "");
    expect(only(parseMoodleQuizPage(input(html), observedAt)).attemptInformation).toMatchObject({
      kind: "known",
      unknownFields: ["state", "used", "remaining"],
      facts: [{ rawText: "Attempts allowed: 1" }, { rawText: "Time limit: 10 mins" }],
    });
  });
  it("login page: the observed HTTP 200 redirect to /login/index.php is a signed-out error", () => {
    expect(loginRedirect.response).toMatchObject({ status: 200, finalPath: "/login/index.php" });
    const loginHtml =
      '<!doctype html><html lang="en"><body id="page-login-index" class="lang-en"><form></form></body></html>';
    for (const requestedUrl of [quizUrl, courseUrl]) {
      expect(
        parseMoodleQuizPage(
          input(loginHtml, {
            requestedUrl,
            finalUrl: origin + loginRedirect.response.finalPath,
            httpStatus: loginRedirect.response.status,
          }),
          observedAt,
        ),
      ).toEqual({
        status: "error",
        page: requestedUrl === quizUrl ? "quiz_view" : "course_quiz_card",
        observations: [],
        diagnostics: [{ reason: "signed_out" }],
        loginUrl: `${origin}/login/index.php`,
      });
    }
    expect(parseMoodleQuizPage(input(observedQuiz, { httpStatus: 401 }), observedAt)).toMatchObject(
      { status: "error", diagnostics: [{ reason: "signed_out" }] },
    );
  });
  it("denied access is an explicit error", () => {
    const deniedHtml = variantOf(
      'id="page-mod-quiz-view"',
      'id="page-site-index"',
      '<!doctype html><html lang="en"><body id="page-mod-quiz-view" class="lang-en"><p>Sorry, but you do not currently have permissions to do that.</p></body></html>',
    );
    expect(parseMoodleQuizPage(input(deniedHtml, { httpStatus: 403 }), observedAt)).toEqual({
      status: "error",
      page: "quiz_view",
      observations: [],
      diagnostics: [{ reason: "denied" }],
    });
  });
  it("observed 404 'Can't find data record' page is a missing-source error", () => {
    expect(
      parseMoodleQuizPage(input(observedNotFound, { httpStatus: 404 }), observedAt),
    ).toMatchObject({
      status: "error",
      observations: [],
      diagnostics: [{ reason: "missing_source" }],
    });
  });
  it.each([
    [
      "missing page id",
      () => variantOf('id="page-mod-quiz-view"', 'id="page-other"'),
      "missing_structure",
    ],
    ["missing cmid class", () => variantOf("cmid-990103 ", ""), "missing_structure"],
    ["missing course class", () => variantOf(" course-9001", ""), "missing_structure"],
    [
      "cmid differs from the URL",
      () => variantOf("cmid-990103", "cmid-990104"),
      "identity_mismatch",
    ],
    [
      "two date regions",
      () =>
        variantOf(
          '<div class="box quizinfo">',
          '<div data-region="activity-dates"></div><div class="box quizinfo">',
        ),
      "malformed_structure",
    ],
    ["duplicate Closed: row", () => variantOf(closedRow, closedRow + closedRow), "duplicate_date"],
    [
      "unparseable date",
      () => variantOf("Saturday, 4 March 2028, 9:00 AM</div>", "Saturday, 4 March 2028</div>"),
      "invalid_date",
    ],
    [
      "weekday contradicts the date",
      () => variantOf("Saturday, 4 March", "Monday, 4 March"),
      "invalid_date",
    ],
    [
      "attempt card without a status",
      () =>
        variantOf(
          '<div class="rui-infobox"><h5 class="rui-infobox-title">Status</h5><div class="rui-infobox-content--small">Finished</div></div>',
          "",
        ),
      "malformed_structure",
    ],
    [
      "attempt card without a title",
      () => variantOf('<h4 class="card-title">Attempt 1</h4>', ""),
      "malformed_structure",
    ],
    [
      "empty attempts list",
      () => observedQuiz.replace(attemptsList, '<div class="rui-attempts-list"></div>\n'),
      "malformed_structure",
    ],
    ["empty document", () => "", "missing_structure"],
    ["missing language marker", () => variantOf(' lang="en"', ""), "missing_structure"],
  ])("malformed: %s is an explicit incomplete result", (_name, html, reason) => {
    const result = parseMoodleQuizPage(input(html()), observedAt);
    expect(result).toMatchObject({
      status: "incomplete",
      observations: [],
      diagnostics: [{ reason }],
    });
  });
  it.each([
    [
      "Russian UI",
      () => variantOf('lang="en"', 'lang="ru"').replace("lang-en", "lang-ru"),
      "unsupported_language",
    ],
    ["body language class only", () => variantOf("lang-en", "lang-kk"), "unsupported_language"],
    [
      "standard attempt table (non-alpha layout)",
      () =>
        variantOf(
          '<div class="rui-attempts-list">',
          '<table class="quizattemptsummary"></table><div class="rui-attempts-list">',
        ),
      "unsupported_theme",
    ],
    [
      "another theme's assets",
      () => variantOf("<h2>", '<img src="/theme/image.php/boost/core/1/i/x"><h2>'),
      "unsupported_theme",
    ],
    [
      "in-progress attempt",
      () => variantOf(">Finished<", ">In progress<"),
      "unsupported_attempt_layout",
    ],
    [
      "multiple attempts",
      () =>
        variantOf(
          '<div class="card">',
          '<div class="card"><h4 class="card-title">Attempt 2</h4></div>\n<div class="card">',
        ),
      "unsupported_attempt_layout",
    ],
    [
      "attempts still available",
      () => variantOf(">No more attempts are allowed<", ">Attempt quiz<"),
      "unsupported_attempt_layout",
    ],
    [
      "future quiz wording Closes:",
      () => variantOf("Closed: Saturday", "Closes: Saturday"),
      "unsupported_date_label",
    ],
  ])("unsupported variant: %s is explicitly unsupported", (_name, html, reason) => {
    expect(parseMoodleQuizPage(input(html()), observedAt)).toMatchObject({
      status: "unsupported",
      observations: [],
      diagnostics: [{ reason }],
    });
  });
  it.each([
    ["network failure", { networkFailure: true }, "error", "network_failure"],
    ["server error", { httpStatus: 503 }, "incomplete", "transient_response"],
    ["partial content", { httpStatus: 206 }, "incomplete", "transient_response"],
    ["non-HTML", { contentType: "application/pdf" }, "error", "unsupported_response"],
    [
      "other origin",
      { finalUrl: "https://moodle.example.test/mod/quiz/view.php?id=990103" },
      "error",
      "untrusted_origin",
    ],
    [
      "credentials in URL",
      { finalUrl: "https://user:pw@moodle.sdu.edu.kz/mod/quiz/view.php?id=990103" },
      "error",
      "untrusted_origin",
    ],
    [
      "redirect to another quiz",
      { finalUrl: `${origin}/mod/quiz/view.php?id=990104` },
      "incomplete",
      "identity_mismatch",
    ],
    [
      "extra query key",
      { requestedUrl: `${quizUrl}&sesskey=x`, finalUrl: `${quizUrl}&sesskey=x` },
      "unsupported",
      "unsupported_page",
    ],
    [
      "unsupported route",
      {
        requestedUrl: `${origin}/mod/assign/view.php?id=1`,
        finalUrl: `${origin}/mod/assign/view.php?id=1`,
      },
      "unsupported",
      "unsupported_page",
    ],
  ] as const)("envelope: %s", (_name, overrides, status, reason) => {
    const result = parseMoodleQuizPage(
      input(observedQuiz, overrides as Partial<MoodleAccessInput>),
      observedAt,
    );
    expect(result).toMatchObject({ status, observations: [], diagnostics: [{ reason }] });
    expect(JSON.stringify(result)).not.toMatch(/sesskey|pw@|example/);
  });
  it.each([undefined, "", "2026-11-01", "private-sentinel", "2026-02-30T10:15Z"])(
    "rejects invalid observedAt %s safely",
    (value) => {
      const result = parseMoodleQuizPage(input(observedQuiz), value as string);
      expect(result).toMatchObject({
        status: "error",
        diagnostics: [{ reason: "invalid_observed_at" }],
      });
      expect(JSON.stringify(result)).not.toContain("private-sentinel");
    },
  );
  it("rejects a malformed runtime envelope", () => {
    expect(parseMoodleQuizPage(null as never, observedAt)).toMatchObject({
      status: "error",
      diagnostics: [{ reason: "invalid_envelope" }],
    });
  });
});

describe("#14 observed date format", () => {
  it.each([
    ["Wednesday, 1 March 2028, 12:00 AM", "2028-03-01T00:00:00+05:00"],
    ["Tuesday, 7 March 2028, 12:30 PM", "2028-03-07T12:30:00+05:00"],
    ["Wednesday, 8 March 2028, 11:59 PM", "2028-03-08T23:59:00+05:00"],
  ])("%s", (text, iso) =>
    expect(parseObservedQuizDate(text)).toEqual({ kind: "exact", iso, tz: "Asia/Almaty" }),
  );
  it.each([
    "Thursday, 30 February 2028, 9:00 AM",
    "Thursday, 2 March 2028, 13:00 PM",
    "Thursday, 2 March 2028, 9:00",
    "2 March 2028",
    "Четверг, 2 марта 2028, 9:00",
  ])("rejects %s", (text) => expect(parseObservedQuizDate(text)).toBeNull());
});
