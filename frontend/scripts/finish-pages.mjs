// Finishes `bun run build:pages` (#49) for https://ramung55.github.io/MoodleHelper/.
// GitHub Pages serves 404.html for unknown paths, so the SPA shell becomes the deep-link fallback.
// .nojekyll keeps files whose names start with "_" (the shell) from being dropped.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = ".output/public";
if (!existsSync(`${out}/_shell.html`))
  throw new Error("Pages build missing _shell.html; run with MOODLE_HELPER_PAGES=1.");
for (const page of ["index.html", "deadlines/index.html", "settings/index.html"]) {
  const html = readFileSync(`${out}/${page}`, "utf8");
  if (!html.includes('"/MoodleHelper/assets/'))
    throw new Error(`${page} does not load assets from /MoodleHelper/.`);
}
copyFileSync(`${out}/_shell.html`, `${out}/404.html`);
writeFileSync(`${out}/.nojekyll`, "");
rmSync(`${out}/_headers`, { force: true }); // Cloudflare-only file; Pages ignores it
console.log(`Pages build ready in frontend/${out} (base /MoodleHelper/, 404.html fallback).`);
