// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
it("prepares matching approved local assets with byte/hash inventory and no extra models", () => {
  const root = "public/ocr/7.0.0/"; const manifest = JSON.parse(readFileSync(root + "inventory.json", "utf8"));
  expect(manifest).toMatchObject({ engine: "7.0.0", core: "7.0.0", data: "1.0.0", mode: "LSTM only" });
  let total = 0;
  for (const entry of manifest.assets) { const bytes = readFileSync(root + entry.file); total += bytes.length; expect(bytes.length).toBe(entry.bytes); expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256); }
  expect(manifest.totalAssetBytes).toBe(total);
  expect(manifest).toEqual(JSON.parse(readFileSync("../_docs/ocr-asset-inventory.json", "utf8")));
  expect(readdirSync(root + "lang").sort()).toEqual(["eng.traineddata.gz", "rus.traineddata.gz"]);
  expect(readdirSync(root + "core").sort()).toHaveLength(6);
  const bootstrap = readFileSync(root + "local-worker.js", "utf8");
  expect(bootstrap).toContain("url.origin !== base.origin"); expect(bootstrap).toContain("credentials: 'omit'"); expect(bootstrap).toContain("options.body");
});
