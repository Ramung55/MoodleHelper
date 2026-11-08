/**
 * Isolated fixture-only Chromium harness (#47). Run from frontend/: `bun run test:e2e`.
 * Chromium only, one worker, no retries (flakes are not hidden), artifacts kept
 * under the ignored browser-workspace/e2e/.artifacts directory, report never auto-opens.
 */
import { defineConfig } from "@playwright/test";
import path from "node:path";

const here = __dirname;
// The deliberately broken variant keeps its own artifacts so it never overwrites a normal run.
const artifacts = path.join(here, ".artifacts", process.env.MH_E2E_BROKEN === "1" ? "broken" : "normal");
const frontend = path.resolve(here, "../../frontend");
// Bundled matching Chromium lives in an ignored project directory (see README).
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(frontend, ".playwright-browsers");

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(artifacts, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(artifacts, "report"), open: "never" }],
    ["json", { outputFile: path.join(artifacts, "results.json") }],
  ],
  use: {
    channel: "chromium", // full bundled Chromium (new headless); the separate headless shell is not installed
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  // The dashboard origin must be exactly 127.0.0.1:5173: the extension relay is
  // scoped to it. Never reuse an existing server, which could hold real data.
  webServer: {
    command: "bun x vite dev --host 127.0.0.1 --port 5173 --strictPort",
    cwd: frontend,
    url: "http://127.0.0.1:5173/?shellState=empty",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
