/** Invented offline structural inputs. Never captured/live SDU compatibility evidence. */
import type { MoodleAccessInput } from "../../../extension/src/moodle-access";
import { account, origin } from "./moodle-access-fixtures";
export function calendarDate(
  field = "start",
  value = "2026-10-25T18:30:00+05:00",
  extra = 'data-timezone="Asia/Almaty"',
  text = "Displayed date",
) {
  return `<time data-date-field="${field}" datetime="${value}" ${extra}>${text}</time>`;
}
export function calendarEvent(
  options: {
    id?: string;
    course?: string | null;
    kind?: string;
    recurrence?: [string, string];
    dates?: string;
    extra?: string;
    title?: string;
  } = {},
) {
  const {
    id = "501",
    course = "101",
    kind = "assessment",
    recurrence,
    dates = calendarDate(),
    extra = "",
    title = "Fictional assessment",
  } = options;
  return `<article data-region="calendar-event" data-event-id="${id}" data-event-kind="${kind}" ${course === null ? "" : `data-course-id="${course}"`} ${recurrence ? `data-series-id="${recurrence[0]}" data-occurrence-id="${recurrence[1]}"` : ""}><h2>${title}</h2><a data-role="event-link" href="/calendar/view.php?event=${id}${recurrence ? `&occurrence=${recurrence[1]}` : ""}">Event</a>${course === null ? "" : `<a data-role="course-link" href="/course/view.php?id=${course}">Course</a>`}${dates}${extra}</article>`;
}
export function calendarPage(events = calendarEvent(), extra = "", attributes = "") {
  return `${account}<main data-region="calendar" data-range-start="2026-10-01" data-range-end="2026-10-31" ${attributes}><h1>Calendar</h1><a href="/calendar/view.php">Calendar</a>${events}${extra}</main>`;
}
export function calendarInput(
  html = calendarPage(),
  overrides: Partial<MoodleAccessInput> = {},
): MoodleAccessInput {
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    requestedUrl: `${origin}/calendar/view.php`,
    finalUrl: `${origin}/calendar/view.php`,
    httpStatus: 200,
    networkFailure: false,
    ...overrides,
  };
}
