import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDocx } from "@/services/validate-docx";
const fixture = readFileSync("src/test/fixtures/local-valid.docx");
const copy = () => Uint8Array.from(fixture);
const validate = (bytes: Uint8Array) => validateDocx(bytes.buffer, new AbortController().signal);
describe("bounded DOCX validation", () => {
  it("accepts a structurally valid synthetic stored archive", async () => { await expect(validate(copy())).resolves.toBeUndefined(); });
  it("rejects truncated and CRC-corrupted archives", async () => {
    await expect(validate(copy().slice(0, -10))).rejects.toThrow(/corrupt/);
    const bytes = copy(); bytes[55] ^= 1;
    await expect(validate(bytes)).rejects.toThrow(/corrupt/);
  });
  it("rejects encrypted entries and bad directory offsets", async () => {
    const encrypted = copy(); encrypted[6] |= 1;
    await expect(validate(encrypted)).rejects.toThrow(/corrupt/);
    const offset = copy(); new DataView(offset.buffer).setUint32(offset.length - 6, 0xffffffff, true);
    await expect(validate(offset)).rejects.toThrow(/corrupt/);
  });
});

