import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** #86 D3: the popup's Open dashboard target. The default build always uses Pages. */
export const PAGES_DASHBOARD = "https://ramung55.github.io/MoodleHelper/";
export const DASHBOARD_URLS = ["http://127.0.0.1:5173/", "http://localhost:5173/", PAGES_DASHBOARD] as const;
export function dashboardUrl(value: string | undefined): string {
  if (value === undefined || value === "") return PAGES_DASHBOARD;
  if (!(DASHBOARD_URLS as readonly string[]).includes(value))
    throw new Error(`MOODLE_HELPER_DASHBOARD_URL must be one of ${DASHBOARD_URLS.join(", ")}`);
  return value;
}

/** #136: the hosted build's tailnet origin; unset or empty selects the unchanged local build. */
export function backendOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/.test(value))
    throw new Error("MOODLE_HELPER_BACKEND_ORIGIN must be https://<machine>.<tailnet>.ts.net (lowercase; no path, trailing slash, port, query, fragment or userinfo)");
  return value;
}

const LOCAL_START_HELP = /<p>Can't reach the local backend\.<\/p>\s*<p>Start it with: <code>[^<]*<\/code><\/p>/;
const HOSTED_START_HELP = "<p>Can't reach the backend.</p>\n      <p>Connect this device to Tailscale, then reconnect.</p>";

export async function build() {
// Checked before anything is removed: an unapproved value fails the build and leaves dist alone.
const origin = backendOrigin(process.env.MOODLE_HELPER_BACKEND_ORIGIN);
if (origin && process.env.MOODLE_HELPER_DASHBOARD_URL)
  throw new Error("Set MOODLE_HELPER_BACKEND_ORIGIN or MOODLE_HELPER_DASHBOARD_URL, not both: the hosted dashboard is the backend origin");
const dashboard = origin ? `${origin}/` : dashboardUrl(process.env.MOODLE_HELPER_DASHBOARD_URL);
// Resolve from this file, never the caller's working directory or an argument.
const output = new URL("./dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
try {
  await mkdir(output, { recursive: true });
  for (const [entry, format, name] of [
    ["index", "iife", "index.js"],
    ["content", "iife", "content.js"],
    ["dashboard-relay", "iife", "dashboard-relay.js"],
    ["popup-entry", "iife", "popup.js"],
    ["transfer-entry", "iife", "transfer.js"],
    ["offscreen-entry", "iife", "offscreen.js"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`./src/${entry}.ts`, import.meta.url))],
      target: "browser",
      format,
      outdir: fileURLToPath(output),
      naming: name,
      define: {
        __MOODLE_HELPER_DASHBOARD_URL__: JSON.stringify(dashboard),
        __MOODLE_HELPER_BACKEND_ORIGIN__: origin ? JSON.stringify(origin) : "undefined",
      },
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed ${entry} build`);
  }
  if (origin) {
    // The hosted manifest differs from the source only in the backend grant and the relay matches.
    const manifest = await Bun.file(new URL("./manifest.json", import.meta.url)).json();
    manifest.host_permissions = [`${origin}/*`, "https://moodle.sdu.edu.kz/*"];
    const relay = manifest.content_scripts.find((c: { js: string[] }) => c.js.includes("dashboard-relay.js"));
    relay.matches = [`${origin}/*`];
    await Bun.write(new URL("manifest.json", output), JSON.stringify(manifest, null, 2) + "\n");
    const popup = await Bun.file(new URL("./public/popup.html", import.meta.url)).text();
    if (!LOCAL_START_HELP.test(popup)) throw new Error("popup.html start help not found");
    await Bun.write(new URL("popup.html", output), popup.replace(LOCAL_START_HELP, HOSTED_START_HELP));
  }
  for (const [source, destination] of [
    ...(origin ? [] : [["./manifest.json", "manifest.json"], ["./public/popup.html", "popup.html"]]),
    ["./public/transfer.html", "transfer.html"],
    ["./public/offscreen.html", "offscreen.html"],
    ["./public/icon-128.png", "icon-128.png"],
  ]) {
    await Bun.write(new URL(destination, output), Bun.file(new URL(source, import.meta.url)));
  }
} catch (error) {
  // A failed build must not leave a partially loadable extension behind.
  await rm(output, { recursive: true, force: true });
  throw error;
}
}

if (import.meta.main) await build();
