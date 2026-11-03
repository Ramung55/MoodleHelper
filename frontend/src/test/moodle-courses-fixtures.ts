/** Invented/unobserved DOM; these selectors are not captured SDU evidence. */
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import { account, origin } from "./moodle-access-fixtures";

export function card(id = "101", title = "Fictional course", terms = ["Fall 2026"], href = `/course/view.php?id=${id}`): string {
  return `<article data-course-id="${id}"><a data-role="course-link" href="${href}">Open course</a><span data-role="course-title">${title}</span>${terms.map(term => `<span data-role="course-term">${term}</span>`).join("")}</article>`;
}
export function list(cards = card(), attributes = "", extra = ""): string {
  // A course-index link supplies #10 evidence even for explicit empty lists.
  return `${account}<main data-region="courses" ${attributes}><h1>Courses</h1><a href="/course/index.php">All courses</a>${cards}${extra}</main>`;
}
export function page(html = list(), overrides: Partial<MoodleAccessInput> = {}): MoodleAccessInput {
  return { document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: `${origin}/my/`, finalUrl: `${origin}/my/`, httpStatus: 200,
    networkFailure: false, ...overrides };
}
