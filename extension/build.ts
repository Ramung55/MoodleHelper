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

export async function build() {
// Checked before anything is removed: an unapproved value fails the build and leaves dist alone.
const dashboard = dashboardUrl(process.env.MOODLE_HELPER_DASHBOARD_URL);
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
      define: { __MOODLE_HELPER_DASHBOARD_URL__: JSON.stringify(dashboard) },
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed ${entry} build`);
  }
  for (const [source, destination] of [
    ["./manifest.json", "manifest.json"],
    ["./public/popup.html", "popup.html"],
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
