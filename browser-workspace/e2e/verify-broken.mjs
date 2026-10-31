// Runs the journey with MH_E2E_BROKEN=1 and proves the failure is loud and specific:
// nonzero exit, the named failing step/expectation, and retained screenshot + trace.
// Exits 0 only when the deliberate failure was detected correctly.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../frontend");
const out = path.join(here, ".artifacts", "broken");
fs.rmSync(out, { recursive: true, force: true }); // harness-owned directory only
const cli = path.join(frontend, "node_modules", "@playwright", "test", "cli.js");
const run = spawnSync(process.execPath, [cli, "test", "--config", path.join(here, "playwright.config.ts"), "journey"], {
  cwd: frontend, stdio: "inherit",
  env: { ...process.env, MH_E2E_BROKEN: "1", NODE_PATH: path.join(frontend, "node_modules") },
});
const problems = [];
if (run.status === 0) problems.push("broken fixture run exited 0 (failure was hidden)");
const results = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8"));
const failures = [];
const walk = (suite) => { for (const s of suite.suites ?? []) walk(s); for (const spec of suite.specs ?? []) for (const t of spec.tests) for (const r of t.results) if (r.status !== "passed") failures.push(r); };
for (const s of results.suites) walk(s);
const failed = failures[0];
const step = (failed?.steps ?? []).find((s) => s.error)?.title ?? "";
const message = failed?.error?.message ?? "";
if (!/Deadlines: reopened submission badge/.test(step)) problems.push(`unexpected failing step: "${step}"`);
if (!/Problem set 4 row badge/.test(message) || !/Moodle: Submitted/.test(message)) problems.push("failure message does not name the expectation");
const attachments = failed?.attachments ?? [];
for (const kind of ["screenshot", "trace"]) {
  const a = attachments.find((x) => x.name === kind && x.path && fs.existsSync(x.path));
  if (!a) problems.push(`missing ${kind} artifact`); else console.log(`${kind}: ${path.relative(process.cwd(), a.path)}`);
}
console.log(`failing step: ${step}`);
console.log(`report: ${path.join(out, "report", "index.html")}`);
if (problems.length) { console.error(`DELIBERATE-FAILURE CHECK FAILED:\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`DELIBERATE-FAILURE CHECK PASSED: playwright exit ${run.status}, failure identified with screenshot and trace.`);
