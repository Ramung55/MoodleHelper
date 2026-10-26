import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const dist = new URL("../extension/dist/", import.meta.url);
const expected = {
  manifest_version: 3,
  name: "Moodle Helper",
  version: "0.0.0",
  background: { service_worker: "index.js", type: "module" },
  action: { default_popup: "popup.html" },
  content_scripts: [{ matches: ["https://moodle.sdu.edu.kz/*"], js: ["content.js"] }],
};

function validateManifest(manifest: unknown) {
  expect(manifest).toEqual(expected);
}

describe("emitted Chrome shell", () => {
  it("emits an inert worker without executable side effects", async () => {
    expect((await readFile(new URL("index.js", dist), "utf8")).trim()).toBe("");
  });
  it("ships exactly the local manifest references with the minimal SDU grant", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
    validateManifest(manifest);
    const references = [manifest.background.service_worker, manifest.action.default_popup,
      ...manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)];
    expect((await readdir(dist)).sort()).toEqual(["manifest.json", ...references].sort());
    for (const reference of references) {
      const bytes = await readFile(new URL(reference, dist));
      // Bun legitimately emits zero bytes for the inert export-only worker.
      if (reference !== "index.js") expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it.each([
    { permissions: ["storage"] }, { host_permissions: ["<all_urls>"] },
    { optional_permissions: ["tabs"] }, { externally_connectable: { matches: ["*://*/*"] } },
    { content_scripts: [{ matches: ["https://*.sdu.edu.kz/*"], js: ["content.js"] }] },
    { content_scripts: [{ matches: ["http://moodle.sdu.edu.kz/*"], js: ["content.js"] }] },
    { content_scripts: [{ matches: ["https://moodle.sdu.edu.kz/*"], js: ["content.js"], all_frames: true }] },
  ])("rejects broadened declarations %j", (change) => {
    expect(() => validateManifest({ ...expected, ...change })).toThrow();
  });

  it("executes the emitted classic script with no page, Chrome, network or storage access", async () => {
    const source = await readFile(new URL("content.js", dist), "utf8");
    const calls: string[] = [];
    const context = Object.create(null);
    for (const name of ["chrome", "document", "window", "fetch", "XMLHttpRequest", "WebSocket",
      "indexedDB", "localStorage", "sessionStorage", "navigator", "setTimeout", "setInterval"])
      Object.defineProperty(context, name, { get() { throw new Error(`Forbidden ${name}`); } });
    context.console = { debug: (message: string) => calls.push(message) };
    runInNewContext(source, context, { timeout: 1000 });
    expect(calls).toEqual(["Moodle Helper: empty content shell loaded"]);
    // The guard is live, rather than a stub that would silently allow activity.
    for (const probe of ["fetch('https://example.com')", "localStorage.getItem('student')", "document.body", "chrome.runtime"])
      expect(() => runInNewContext(probe, context)).toThrow(/Forbidden/);
  });

  it("keeps the popup blank and local, with a title and usable dimensions", async () => {
    const html = await readFile(new URL("popup.html", dist), "utf8");
    expect(html).toMatch(/<title>Moodle Helper<\/title>/);
    expect(html).toMatch(/<body>\s*<\/body>/);
    expect(html).toMatch(/width:\s*280px/);
    expect(html).toMatch(/min-height:\s*160px/);
    expect(html).not.toMatch(/<script|\bsrc\s*=|\bhref\s*=|\bon\w+\s*=/i);
  });
});
