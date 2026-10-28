// @vitest-environment node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
const tasks = vi.hoisted(() => ({ destroy: [] as ReturnType<typeof vi.fn>[] }));

// Use real PDF.js with its matching local Node worker shim, not mocked text output.
vi.mock("pdfjs-dist", async () => {
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { ...pdf, getDocument: (...args: Parameters<typeof pdf.getDocument>) => {
    const task = pdf.getDocument(...args); const destroy = vi.fn(task.destroy.bind(task)); task.destroy = destroy; tasks.destroy.push(destroy); return task;
  }, GlobalWorkerOptions: { set workerSrc(_url: string) { pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href; } } };
});
import { extractPdf } from "@/services/extract-pdf";
const file = (name = "extraction-bilingual.pdf") => new Blob([readFileSync(`src/test/fixtures/${name}`)]);
beforeEach(() => { tasks.destroy = []; });

describe("real local PDF extraction", () => {
  it("rejects oversized input before reading or starting a worker", async () => {
    const read = vi.fn();
    await expect(extractPdf({ size: 20 * 1024 * 1024 + 1, arrayBuffer: read } as unknown as Blob, new AbortController().signal, vi.fn())).rejects.toThrow(/20 MiB/);
    expect(read).not.toHaveBeenCalled(); expect(tasks.destroy).toHaveLength(0);
  });
  it("retains English/Russian pages and individual schedule rows, image-only and blank evidence", async () => {
    const progress = vi.fn();
    const pages = await extractPdf(file(), new AbortController().signal, progress);
    expect(pages.map((page) => [page.page, page.status])).toEqual([[1, "text"], [2, "text"], [3, "ocr_needed"], [4, "blank"]]);
    expect(pages[0]!.rows.map((row) => row.text)).toContain("Assignment 1 29 October 2026");
    expect(pages[0]!.rows.map((row) => row.text)).toContain("Quiz 2 5 November 2026");
    const russian = pages[1]!.rows.find((row) => row.text.includes("Задание 1"))!;
    expect(russian.text).toBe("Задание 1 29 октября 2026");
    expect(russian.items).toHaveLength(2);
    expect(russian.items[0]).toMatchObject({ page: 2, transform: [12, 0, 0, 12, 40, 290] });
    expect(russian.items[1]!.transform[4]).toBe(260);
    expect(progress.mock.calls).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(tasks.destroy).toHaveLength(2); for (const destroy of tasks.destroy) expect(destroy).toHaveBeenCalled();
  });
  it.each(["local-truncated.pdf", "local-encrypted.pdf", "local-encrypted-marker.pdf"])("rejects %s without successful empty output", async (name) => {
    await expect(extractPdf(file(name), new AbortController().signal, vi.fn())).rejects.toThrow(/corrupt|unsupported|protected/i);
  });
  it("cancels before reading and after the first page without publishing partial pages", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(extractPdf(file(), controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    const during = new AbortController(); const progress = vi.fn((page) => { if (page === 1) during.abort(); });
    await expect(extractPdf(file(), during.signal, progress)).rejects.toMatchObject({ name: "AbortError" });
    expect(progress.mock.calls.at(-1)).toEqual([1, 4]);
    for (const destroy of tasks.destroy) expect(destroy).toHaveBeenCalled();
  });
});
