/** Invented/unobserved structural inputs, never captured SDU evidence or expected output. */
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import { account, origin } from "./moodle-access-fixtures";
export function dateNode(field = "due", value = "2026-10-25T18:30:00+05:00", scope = "base", extra = 'data-timezone="Asia/Almaty"'): string {
  return `<time data-date-field="${field}" data-date-scope="${scope}" datetime="${value}" ${extra}> Displayed   date </time>`;
}
export function assignment(dates = dateNode(), extra = ""): string {
  return `${account}<main data-region="activity"><article data-region="assignment" data-course-id="101" data-assignment-id="202" data-course-module-id="303"><h1> Fictional   assignment </h1><a data-role="assignment-link" href="/mod/assign/view.php?id=303">Assignment</a><a data-role="course-link" href="/course/view.php?id=101">Course</a>${dates}${extra}</article></main>`;
}
export function assignmentInput(html = assignment(), overrides: Partial<MoodleAccessInput> = {}): MoodleAccessInput {
  return { document: new DOMParser().parseFromString(html, "text/html"), requestedUrl: `${origin}/mod/assign/view.php?id=303`, finalUrl: `${origin}/mod/assign/view.php?id=303`, httpStatus: 200, networkFailure: false, ...overrides };
}
