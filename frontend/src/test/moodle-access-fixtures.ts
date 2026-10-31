/** Invented structural contracts, not captured SDU HTML or supported selectors.
 * Kept outside #4's strictly inert HTML corpus; DOMParser does not execute them.
 */
export const origin = "https://moodle.sdu.edu.kz";
export const account = '<nav aria-label="Account"><a href="/login/logout.php">Sign out</a></nav>';
export const course = '<main data-region="course-content"><h1>Fictional course</h1><a href="/mod/assign/view.php?id=fiction-1">Activity</a></main>';
export const login = '<main><h1>Sign in</h1><form action="/login/index.php"><input name="username" type="text"><input name="password" type="password"></form></main>';
export const denied = '<main><h1>Unavailable</h1><div role="alert" data-errorcode="nopermissions">Access denied</div></main>';
export const unsupported = `${account}<main><h1>Fictional preferences</h1></main>`;
export const envelope = {
  requestedUrl: `${origin}/course/view.php?id=fiction-1`,
  finalUrl: `${origin}/course/view.php?id=fiction-1`,
  httpStatus: 200,
  networkFailure: false,
  contentType: "text/html; charset=utf-8",
} as const;
