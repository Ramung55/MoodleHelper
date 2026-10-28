import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { DecompressionStream as NodeDecompressionStream } from "node:stream/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateDocx } from "@/services/validate-docx";
const fixture = readFileSync("src/test/fixtures/local-valid.docx");
const copy = () => Uint8Array.from(fixture);
const validate = (bytes: Uint8Array) => validateDocx(bytes.buffer, new AbortController().signal);
afterEach(() => vi.unstubAllGlobals());
describe("bounded DOCX validation", () => {
  it("accepts a structurally valid synthetic stored archive", async () => { await expect(validate(copy())).resolves.toBeUndefined(); });
  it("validates real raw-DEFLATE entries and rejects corrupted compressed bytes", async () => {
    vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("DecompressionStream", NodeDecompressionStream);
    const bytes = Uint8Array.from(readFileSync("src/test/fixtures/local-deflated.docx"));
    await expect(validate(bytes)).resolves.toBeUndefined();
    bytes[55] ^= 1;
    await expect(validate(bytes)).rejects.toThrow(/corrupt/);
  });
  it("validates streaming ZIP data descriptors and rejects altered descriptor fields", async () => {
    vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("DecompressionStream", NodeDecompressionStream);
    const bytes = Uint8Array.from(readFileSync("src/test/fixtures/local-descriptor.docx"));
    await expect(validate(bytes)).resolves.toBeUndefined();
    const signature = Uint8Array.of(0x50, 0x4b, 0x07, 0x08);
    const pos = bytes.findIndex((_, i) => signature.every((b, j) => bytes[i + j] === b));
    expect(pos).toBeGreaterThan(0);
    bytes[pos + 4] ^= 1;
    await expect(validate(bytes)).rejects.toThrow(/corrupt/);
  });
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

