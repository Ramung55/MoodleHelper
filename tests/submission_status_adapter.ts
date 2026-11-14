// #126 test-only: runs the REAL extension submission adapter on SYNTHETIC assignment HTML.
// Usage: bun tests/submission_status_adapter.ts <courseId> <cmid> <observedAt> < page.html
// Prints the CollectorResult JSON. Never fetches anything; Moodle is never contacted.
import { JSDOM } from "../frontend/node_modules/jsdom";
import { submissionRefreshResult } from "../extension/src/page-refresh";

const [course, cmid, observedAt] = process.argv.slice(2);
const url = `https://moodle.sdu.edu.kz/mod/assign/view.php?id=${cmid}`;
const document = new JSDOM(await Bun.stdin.text(), { url }).window.document;
const result = submissionRefreshResult(
  { document, requestedUrl: url, finalUrl: url, httpStatus: 200, networkFailure: false, contentType: "text/html",
    expectedSourceCourseId: course!, expectedSourceCourseModuleId: cmid! },
  observedAt!,
);
console.log(JSON.stringify(result));
