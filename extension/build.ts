import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Resolve from this file, never the caller's working directory or an argument.
const output = new URL("./dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
try {
  await mkdir(output, { recursive: true });
  for (const [entry, format, name] of [
    ["index", "esm", "index.js"],
    ["content", "iife", "content.js"],
    ["dashboard-relay", "iife", "dashboard-relay.js"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL(`./src/${entry}.ts`, import.meta.url))],
      target: "browser",
      format,
      outdir: fileURLToPath(output),
      naming: name,
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed ${entry} build`);
  }
  for (const [source, destination] of [
    ["./manifest.json", "manifest.json"],
    ["./public/popup.html", "popup.html"],
  ]) {
    await Bun.write(new URL(destination, output), Bun.file(new URL(source, import.meta.url)));
  }
} catch (error) {
  // A failed build must not leave a partially loadable extension behind.
  await rm(output, { recursive: true, force: true });
  throw error;
}
