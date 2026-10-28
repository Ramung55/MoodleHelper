import { readFileSync } from "node:fs";
import { Blob as NodeBlob } from "node:buffer";
import { DecompressionStream as NativeDecompressionStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { extractDocx } from "@/services/extract-docx";
import { LocalExtraction } from "@/components/mh/LocalExtraction";
const mock = vi.hoisted(() => ({ read: vi.fn(), context: vi.fn() }));
vi.mock("@/services/local-documents", () => ({ readLocalDocument: mock.read, currentDataset: mock.context }));
const file = (name = "extraction-bilingual.docx") => new NodeBlob([readFileSync(`src/test/fixtures/${name}`)]);
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("Blob", NodeBlob); vi.stubGlobal("DecompressionStream", NativeDecompressionStream); mock.read.mockResolvedValue(file()); mock.context.mockResolvedValue("dataset"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("native DOCX extraction", () => {
  it.each(["extraction-bilingual.docx", "extraction-bilingual-deflated.docx"])("reads bilingual paragraphs/tables and exact locations from %s without fetching relationships", async (name) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); const progress = vi.fn();
    const blocks = await extractDocx(file(name) as unknown as Blob, new AbortController().signal, progress);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "table", "paragraph", "table", "paragraph"]);
    expect(blocks[0]).toMatchObject({ paragraph: { text: "Synthetic English syllabus\tSchedule\nSecond line", location: { part: "word/document.xml", bodyBlock: 1, paragraph: 1 } } });
    expect(blocks[2]).toMatchObject({ paragraph: { text: "Синтетическая программа", location: { bodyBlock: 3, paragraph: 2 } } });
    const table = blocks[3]!; expect(table.kind).toBe("table");
    if (table.kind === "table") expect(table.rows[0]!.cells[1]!.paragraphs[0]).toEqual({ id: "word/document.xml/body4/table2/row1/cell2/p1", text: "5 ноября 2026", location: { part: "word/document.xml", bodyBlock: 4, table: 2, row: 1, cell: 2, paragraph: 1 } });
    expect(JSON.stringify(blocks)).toContain("Visible external link"); expect(fetcher).not.toHaveBeenCalled();
    expect(progress.mock.calls.at(-1)).toEqual([6, 6]);
  });
  it.each(["local-valid.docx", "local-deflated.docx", "local-descriptor.docx"])("uses the same bounded reader for supported ZIP layout %s", async (name) => {
    // Existing empty validation fixtures remain valid containers, but not false extraction successes.
    await expect(extractDocx(file(name) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/no supported body text|unsupported body structure/);
  });
  it.each(["extraction-unsupported.docx", "extraction-nested.docx", "extraction-empty.docx"])("rejects unsupported/empty content in %s", async (name) => {
    await expect(extractDocx(file(name) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/unsupported|no supported body text/);
  });
  it("distinguishes corrupt, known encrypted and unsupported containers", async () => {
    const bytes = Uint8Array.from(readFileSync("src/test/fixtures/extraction-bilingual.docx"));
    await expect(extractDocx(new NodeBlob([bytes.slice(0, -10)]) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/corrupt/);
    const encrypted = bytes.slice(); const central = encrypted.findIndex((_, i) => encrypted[i] === 0x50 && encrypted[i+1] === 0x4b && encrypted[i+2] === 1 && encrypted[i+3] === 2); encrypted[central + 8] |= 1;
    await expect(extractDocx(new NodeBlob([encrypted]) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/password-protected or encrypted/);
    await expect(extractDocx(new NodeBlob(["not DOCX"]) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/not a supported DOCX/);
    const compound = new Uint8Array(160); compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(extractDocx(new NodeBlob([compound]) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/unsupported binary Office/);
    const markers = "EncryptedPackage\0EncryptionInfo";
    for (let i = 0; i < markers.length; i++) compound[16 + i * 2] = markers.charCodeAt(i);
    await expect(extractDocx(new NodeBlob([compound]) as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/password-protected or encrypted/);
    await expect(extractDocx(file("extraction-entity.docx") as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/corrupt/);
  });
  it("cancels before reading and between body blocks without a complete result", async () => {
    const aborted = new AbortController(); aborted.abort();
    await expect(extractDocx(file() as unknown as Blob, aborted.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController(); const progress = vi.fn((block) => { if (block === 1) during.abort(); });
    await expect(extractDocx(file() as unknown as Blob, during.signal, progress)).rejects.toMatchObject({ name: "AbortError" });
    expect(progress.mock.calls.at(-1)).toEqual([1, 6]);
  });
  it("renders actual extracted hostile markup and hyperlink text inertly with original cell references", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    render(<LocalExtraction document={{ datasetId: "dataset", courseId: "course", digest: "digest", name: "sample.docx", size: 100, source: "Local", createdAt: "now" }} />);
    fireEvent.click(screen.getByText("Extract text"));
    const hostile = await screen.findByText(/<img src=/, { selector: "summary" }); expect(hostile.tagName).toBe("SUMMARY");
    expect(document.querySelector("img")).toBeNull(); expect(document.querySelector("a")).toBeNull();
    fireEvent.click(screen.getByText("5 ноября 2026", { selector: "summary" }));
    expect(screen.getByText(/word\/document.xml\/body4\/table2\/row1\/cell2\/p1/)).toBeVisible();
    expect(screen.queryByText(/Page \d/)).not.toBeInTheDocument(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates cancellation into an active decompression reader", async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    vi.stubGlobal("DecompressionStream", vi.fn(function () { return {
      readable: new ReadableStream({ start() { setTimeout(() => controller.abort(), 0); }, cancel }),
      writable: new WritableStream(),
    }; }));
    await expect(extractDocx(file("extraction-bilingual-deflated.docx") as unknown as Blob, controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
