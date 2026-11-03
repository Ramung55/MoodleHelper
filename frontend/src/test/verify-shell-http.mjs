// Native HTTP checks against separately started real dev and built local servers.
// This verifies SSR/refresh responses and client asset availability, not browser hydration.
import assert from "node:assert/strict";
const [development, production] = process.argv.slice(2);
assert(development && production, "Usage: node src/test/verify-shell-http.mjs DEV_ORIGIN PRODUCTION_ORIGIN");
const routes = [["/", "Overview"], ["/deadlines", "Deadlines"], ["/syllabus", "Syllabus review"], ["/materials", "Materials"], ["/settings", "Settings"]];
let responses = 0;
for (const [origin, dev] of [[development, true], [production, false]]) {
  for (const [path, heading] of routes) {
    for (const state of [undefined, "loading", "empty", "error", "invalid"]) {
      const url = `${origin}${path}${state ? `?shellState=${state}` : ""}`;
      for (let refresh = 0; refresh < 2; refresh++) {
        const response = await fetch(url, { headers: { Accept: "text/html", "Cache-Control": "no-cache" } });
        const html = await response.text();
        assert.equal(response.status, 200, url);
        assert.match(response.headers.get("content-type"), /text\/html/);
        const headings = [...html.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/gs)];
        assert.equal(headings.length, 1, url);
        assert.equal(headings[0][1], heading, url);
        const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
        assert.equal(current.length, 1, url);
        assert.match(current[0][0], new RegExp(`href="${path.replaceAll("/", "\\/")}(?:\\?|\")`));
        const preview = dev && ["loading", "empty", "error"].includes(state);
        assert.equal(html.includes("Development preview."), preview, url);
        if (preview && state === "error") { assert.match(html, /role="alert"/); assert.match(html, />Retry<\/button>/); }
        if (preview && state === "empty") assert.match(html, /No data is present/);
        if (!preview || state === "loading") assert.match(html, /aria-busy="true"/);
        if (!preview) assert.match(html, /Connecting to local backend/);
        if (!dev) {
          assert.doesNotMatch(html, /Development preview\.|Exit preview|simulated error|No data is present/);
          const script = html.match(/<script[^>]*src="([^"]+)"/);
          assert(script, `${url}: hydration entry script is present`);
          const asset = await fetch(new URL(script[1], origin));
          assert.equal(asset.status, 200, script[1]);
          assert.match(asset.headers.get("content-type"), /javascript/);
        }
        responses++;
      }
    }
  }
  const unknown = await fetch(`${origin}/missing-shell-route`);
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Page not found/);
  console.log(`${dev ? "DEV" : "PRODUCTION"}: 50 direct/refresh HTML responses passed; unknown route 404; production client assets checked.`);
}
console.log(`${responses} route responses verified. Browser hydration, tab order and painted focus require separate manual evidence.`);
