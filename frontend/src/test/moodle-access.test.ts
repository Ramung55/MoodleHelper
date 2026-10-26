import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectMoodleAccess, type MoodleAccessInput } from "../../../extension/src/moodle-access";
import { account, course, denied, envelope, login, origin, unsupported } from "./moodle-access-fixtures";

function documentFor(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}
function check(html: string, overrides: Partial<MoodleAccessInput> = {}) {
  return detectMoodleAccess({ ...envelope, document: documentFor(html), ...overrides });
}

describe("synthetic independently callable Moodle access policy", () => {
  it.each([
    [account + course, {}, "accessible"],
    [login, { finalUrl: `${origin}/login/index.php` }, "signed_out"],
    [login, {}, "signed_out"],
    [denied, {}, "forbidden"],
    [unsupported, { finalUrl: `${origin}/user/preferences.php` }, "unsupported"],
  ] as const)("classifies distinct structural cases", (html, overrides, expected) => {
    const actual = check(html, overrides);
    expect(actual.status).toBe(expected);
    expect(actual.retryable).toBe(false);
    expect(actual.loginUrl).toBe(expected === "signed_out" ? `${origin}/login/index.php` : undefined);
  });

  it.each([
    ["/my/", "courses"], ["/course/index.php", "courses"],
    ["/calendar/view.php", "calendar"], ["/mod/quiz/view.php", "activity"],
    ["/mod/assign/view.php", "activity"], ["/mod/resource/view.php", "activity"],
    ["/mod/folder/view.php", "activity"], ["/mod/url/view.php", "activity"],
  ])("requires route-specific content for %s", (path, region) => {
    const html = `${account}<main data-region="${region}"><h1>Example</h1><a href="/course/view.php?id=fake">Course</a></main>`;
    expect(check(html, { finalUrl: origin + path }).status).toBe("accessible");
    expect(check(html.replace('data-region="' + region + '"', 'data-region="unrelated"'), { finalUrl: origin + path }).status).toBe("unknown");
  });

  it.each([
    "", "<title>Course login</title><main>Public course</main>",
    '<a href="/login/index.php">Login</a>', account, course,
    account + '<main data-region="course-content"><h1>Course</h1></main>',
    account + '<main data-region="course-content"><a href="/course/view.php">Course</a></main>',
    account + '<main data-region="course-content"><h1>Course</h1><a href="https://evil.invalid/course/view.php">Course</a></main>',
    '<form action="/login/index.php"><input name="username" type="text"></form>',
    login.replace('/login/index.php', 'https://evil.invalid/login/index.php'),
    '<main><h1>Access denied</h1><div role="alert">Denied</div></main>',
    '<main data-fact="access_outcome">denied login_redirect accessible</main>',
  ])("keeps weak/public/incomplete evidence unknown", html => {
    expect(check(html)).toMatchObject({ status: "unknown", retryable: true });
  });

  it.each(["courses", "assignment", "login", "denied", "incomplete"])("does not classify #4 fact-only %s fixture", name => {
    const html = readFileSync(resolve(process.cwd(), "../tests/fixtures/moodle", `${name}.html`), "utf8");
    expect(check(html).status).toBe("unknown");
    expect(check(html.replaceAll("data-fact", "irrelevant")).status).toBe("unknown");
  });

  it.each([
    [401, "", "signed_out"], [403, "", "forbidden"],
    [403, account, "forbidden"], [403, account + course, "unknown"],
    [403, login, "unknown"], [401, account + course, "unknown"],
    [401, denied, "unknown"], [404, account + course, "unsupported"],
    [400, account + course, "unsupported"], [408, login, "unknown"],
    [425, denied, "unknown"], [429, login, "unknown"],
    [500, login, "unknown"], [503, account + course, "unknown"],
    [302, login, "unknown"], [204, "", "unknown"],
    [204, account + course, "unknown"], [206, account + course, "unknown"],
  ])("applies transport precedence for %s", (httpStatus, html, expected) => {
    const actual = check(html, { httpStatus });
    expect(actual.status).toBe(expected);
    expect(actual.retryable).toBe(expected === "unknown");
  });

  it.each([account + course + login, denied + login, account + course + denied, account + login])("keeps contradictory strong signals unknown", html => {
    expect(check(html)).toMatchObject({ status: "unknown", reason: "conflicting_evidence" });
  });

  it.each([
    "http://moodle.sdu.edu.kz/course/view.php", "https://moodle.sdu.edu.kz.evil.invalid/course/view.php",
    "https://other.moodle.sdu.edu.kz/course/view.php", "https://moodle.sdu.edu.kz:444/course/view.php",
    "https://user:secret@moodle.sdu.edu.kz/course/view.php", "https://evil.invalid/course/view.php",
    "https://@moodle.sdu.edu.kz/course/view.php",
    "file:///course/view.php", "https://moodle.sdu.edu.kz./course/view.php",
  ])("rejects untrusted requested and final origins", url => {
    expect(check(account + course, { finalUrl: url }).reason).toBe("untrusted_origin");
    expect(check(account + course, { requestedUrl: url }).reason).toBe("untrusted_origin");
  });

  it("accepts only the canonical HTTPS origin including explicit default port", () => {
    expect(check(account + course, { finalUrl: "https://moodle.sdu.edu.kz:443/course/view.php" }).status).toBe("accessible");
  });

  it.each([
    { httpStatus: NaN }, { httpStatus: 0 }, { httpStatus: 199 }, { httpStatus: 600 }, { httpStatus: 200.5 },
    { finalUrl: "not a URL" }, { requestedUrl: "" }, { finalUrl: " https://moodle.sdu.edu.kz/course/view.php" },
    { networkFailure: undefined }, { document: null }, { contentType: "" },
    { document: {} }, { contentType: 17 },
    { finalUrl: "https:moodle.sdu.edu.kz/course/view.php" },
  ])("rejects malformed runtime envelopes safely", overrides => {
    expect(check(account + course, overrides as Partial<MoodleAccessInput>)).toMatchObject({ status: "unknown", reason: "invalid_envelope", retryable: true });
  });

  it("handles missing type, nonHTML and incomplete final login route", () => {
    expect(check(account + course, { contentType: undefined }).status).toBe("accessible");
    expect(check(account + course, { contentType: "application/json" }).status).toBe("unsupported");
    expect(check("", { finalUrl: `${origin}/login/index.php` }).status).toBe("unknown");
    expect(check(login, { networkFailure: true }).reason).toBe("network_failure");
  });

  it("never reads credential values or reflects page, query, user or exception contents", () => {
    const secret = "PRIVATE_SENTINEL_782";
    const doc = documentFor(login + `<p>${secret}</p>`);
    for (const field of doc.querySelectorAll("input")) {
      Object.defineProperty(field, "value", { get: () => { throw new Error(secret); } });
      const original = field.getAttribute.bind(field);
      vi.spyOn(field, "getAttribute").mockImplementation(name => {
        if (name === "value") throw new Error(secret);
        return original(name);
      });
    }
    const output = check("", { document: doc, finalUrl: `${origin}/login/index.php?sesskey=${secret}` });
    expect(output.status).toBe("signed_out");
    expect(JSON.stringify(output)).not.toContain(secret);
    const badDoc = documentFor("");
    vi.spyOn(badDoc, "querySelectorAll").mockImplementation(() => { throw new Error(secret); });
    expect(JSON.stringify(check("", { document: badDoc }))).not.toContain(secret);
    expect(JSON.stringify(check("", { finalUrl: `https://${secret}:${secret}@moodle.sdu.edu.kz/` }))).not.toContain(secret);
  });

  it("returns fresh primitive results with no input, DOM or persistence side effects", () => {
    const doc = documentFor(login);
    const html = doc.documentElement.outerHTML;
    const savedCourses = Object.freeze([Object.freeze({ id: "saved-course" })]);
    const savedBefore = JSON.stringify(savedCourses);
    const input = Object.freeze({ ...envelope, document: doc });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const mutationSpy = vi.fn();
    const observer = new MutationObserver(mutationSpy);
    observer.observe(doc, { subtree: true, attributes: true, childList: true, characterData: true });
    try {
      const first = detectMoodleAccess(input);
      first.message = "changed by caller";
      expect(detectMoodleAccess(input).message).toBe("Sign in to SDU Moodle to continue.");
      for (const overrides of [{}, { networkFailure: true }, { httpStatus: 403 }, { finalUrl: "bad" }]) {
        const output = detectMoodleAccess(Object.freeze({ ...input, ...overrides }));
        expect(Object.values(output).every(value => ["string", "boolean"].includes(typeof value))).toBe(true);
      }
      expect(doc.documentElement.outerHTML).toBe(html);
      expect(observer.takeRecords()).toEqual([]);
      expect(JSON.stringify(savedCourses)).toBe(savedBefore);
      expect(input).toEqual({ ...envelope, document: doc });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(storageSpy).not.toHaveBeenCalled();
    } finally {
      observer.disconnect(); fetchSpy.mockRestore(); storageSpy.mockRestore();
    }
  });
});
