/**
 * Pure, conservative synthetic access contract for #10; live SDU compatibility
 * and these route/selector conventions remain UNVERIFIED under #3.
 *
 * A session signal is account navigation containing a canonical logout link.
 * Accessible requires that signal AND a route-specific main region with a
 * heading and a canonical course/activity/calendar link. A marker alone is
 * insufficient. Login requires a canonical login form with username/password
 * controls (only their attributes, never values, are inspected). Explicit DOM
 * denial requires a main heading plus a nopermissions alert. No body text,
 * data-fact labels, title, or manifest expectation is classification evidence.
 *
 * Conflict policy: login plus session navigation/denial, or denial plus complete
 * accessible content, is unknown. 403 plus ordinary session navigation is still
 * forbidden; 403 plus login or complete accessible content is contradictory.
 * 401 plus session/denial is unknown. Final login route requires complete login
 * DOM, even after a redirect, to avoid treating incomplete responses as proof.
 * Other 4xx are unsupported; 408/425/429, 5xx and unresolved 3xx are retryable.
 * Only a complete 200 response can establish DOM-based access; other 2xx
 * responses are conservatively incomplete (including 204/205/206).
 * Missing content type is allowed; successful non-HTML is unsupported.
 * All outputs contain detached allowlisted primitives. Nothing is fetched,
 * navigated, persisted, mutated or logged; the inert shell does not call this.
 */

export interface MoodleAccessInput {
  readonly document: Document;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly networkFailure: boolean;
  readonly contentType?: string;
}

const diagnostics = {
  accessible: ["accessible", "Supported page evidence is available."],
  login: ["signed_out", "Sign in to SDU Moodle to continue."],
  denied: ["forbidden", "Access to this page is denied."],
  untrusted_origin: ["unsupported", "This origin is not supported."],
  unsupported_response: ["unsupported", "This response is not supported."],
  unsupported_route: ["unsupported", "This page route is not supported."],
  invalid_envelope: ["unknown", "Page evidence is invalid or incomplete."],
  network_failure: ["unknown", "Page access could not be checked. Retry later."],
  transient_response: ["unknown", "The response is incomplete or temporary. Retry later."],
  conflicting_evidence: ["unknown", "Page evidence is contradictory. Retry later."],
  ambiguous_content: ["unknown", "Page access is not established. Retry later."],
} as const;

export type MoodleAccessReason = keyof typeof diagnostics;
export type MoodleAccessStatus = (typeof diagnostics)[MoodleAccessReason][0];
export interface MoodleAccessResult {
  status: MoodleAccessStatus;
  retryable: boolean;
  reason: MoodleAccessReason;
  message: string;
  loginUrl?: "https://moodle.sdu.edu.kz/login/index.php";
}

function result(reason: MoodleAccessReason): MoodleAccessResult {
  const [status, message] = diagnostics[reason];
  return {
    status, retryable: status === "unknown", reason, message,
    ...(status === "signed_out" ? { loginUrl: "https://moodle.sdu.edu.kz/login/index.php" as const } : {}),
  };
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string" || /[\s\\]/.test(value) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}

function trusted(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === "moodle.sdu.edu.kz" &&
    !url.username && !url.password && (!url.port || url.port === "443");
}

function hasUserinfo(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value);
}

function canonicalLink(value: string | null, base: URL, path: (path: string) => boolean): boolean {
  if (!value || /[\s\\]/.test(value) || hasUserinfo(value) || /^\/\/[^/?#]*@/.test(value)) return false;
  try {
    const url = new URL(value, base);
    return trusted(url) && path(url.pathname);
  } catch { return false; }
}

function region(path: string): string | undefined {
  if (path === "/my/" || path === "/course/index.php") return "courses";
  if (path === "/course/view.php") return "course-content";
  if (path === "/calendar/view.php") return "calendar";
  if (/^\/mod\/(assign|quiz|resource|folder|url)\/view\.php$/.test(path)) return "activity";
  return undefined;
}

export function detectMoodleAccess(input: MoodleAccessInput): MoodleAccessResult {
  // Catch malformed runtime envelopes/DOM implementations without reflecting
  // their values or exceptions. The function never reads credential values.
  try {
    if (!input || typeof input.networkFailure !== "boolean" ||
        !Number.isInteger(input.httpStatus) || input.httpStatus < 0 || input.httpStatus > 599 ||
        (input.contentType !== undefined && typeof input.contentType !== "string")) {
      return result("invalid_envelope");
    }
    const requested = parseUrl(input.requestedUrl);
    const final = parseUrl(input.finalUrl);
    if (!requested || !final) return result("invalid_envelope");
    if (!trusted(requested) || !trusted(final) || hasUserinfo(input.requestedUrl) || hasUserinfo(input.finalUrl)) return result("untrusted_origin");
    if (input.networkFailure) return result("network_failure");
    const status = input.httpStatus;
    if (status < 200) return result("invalid_envelope");
    if (status >= 500 || [408, 425, 429].includes(status) || (status >= 300 && status < 400)) {
      return result("transient_response");
    }
    if (status >= 400 && status !== 401 && status !== 403) return result("unsupported_response");
    if (status >= 200 && status < 300 && status !== 200) return result("transient_response");
    if (input.contentType !== undefined) {
      const mime = input.contentType.split(";", 1)[0].trim().toLowerCase();
      if (!mime) return result("invalid_envelope");
      if (mime !== "text/html" && mime !== "application/xhtml+xml") return result("unsupported_response");
    }
    const doc = input.document;
    if (!doc || doc.nodeType !== 9 || !doc.documentElement || !doc.body ||
        doc.documentElement.localName !== "html") return result("invalid_envelope");
    const links = (scope: ParentNode, selector: string, predicate: (path: string) => boolean) =>
      Array.from(scope.querySelectorAll(selector)).some(node =>
        canonicalLink(node.getAttribute("href"), final, predicate));
    const session = links(doc, 'nav[aria-label="Account"] a[href]', path => path === "/login/logout.php");
    const login = Array.from(doc.querySelectorAll("form[action]")).some(form =>
      canonicalLink(form.getAttribute("action"), final, path => path === "/login/index.php") &&
      !!form.querySelector('input[name="username"][type="text"], input[name="username"][type="email"]') &&
      !!form.querySelector('input[name="password"][type="password"]'));
    const denied = !!doc.querySelector('main h1') &&
      !!doc.querySelector('main [role="alert"][data-errorcode="nopermissions"]');
    const pageRegion = region(final.pathname);
    const main = pageRegion ? doc.querySelector(`main[data-region="${pageRegion}"]`) : null;
    const accessible = session && !!main?.querySelector("h1") &&
      links(main, "a[href]", path => region(path) !== undefined);
    if ((login && (session || denied)) || (denied && accessible)) return result("conflicting_evidence");
    if (status === 401) return result(session || denied ? "conflicting_evidence" : "login");
    if (status === 403) return result(login || accessible ? "conflicting_evidence" : "denied");
    if (denied) return result("denied");
    if (login) return result("login");
    // Route-only login evidence is deliberately insufficient for a 200 response.
    if (final.pathname === "/login/index.php") return result("ambiguous_content");
    if (accessible) return result("accessible");
    if (!pageRegion && session && doc.querySelector("main h1")) return result("unsupported_route");
    return result("ambiguous_content");
  } catch {
    return result("invalid_envelope");
  }
}
