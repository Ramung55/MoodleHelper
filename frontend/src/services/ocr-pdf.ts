import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createLocalOcrEngine, type LocalOcrEngine, type OcrEngineOutput } from "./local-ocr-worker";

export type OcrLimits = { maxPages: number; dpi: number; millisecondsPerPage: number; maxPixels: number; maxCharacters: number };
export const DEFAULT_OCR_LIMITS: OcrLimits = { maxPages: 20, dpi: 120, millisecondsPerPage: 60_000, maxPixels: 8_000_000, maxCharacters: 100_000 };
export type OcrPage = { page: number; width: number; height: number; text: string; confidence: number; regions: { text: string; confidence: number; bounds: number[] }[]; status: "recognized" | "review_needed" | "failed"; error?: string };
export type OcrJob = { selectedPages: number[]; pages: OcrPage[]; complete: boolean; status: "complete" | "incomplete" | "cancelled"; language: "eng" | "rus" | "eng+rus"; dpi: number; engine: "tesseract.js-7.0.0" };
export type OcrProgress = { completed: number; failed: number; remaining: number; total: number; currentPage?: number; currentProgress: number; pages: OcrPage[] };
export interface OcrPdf { pageCount: number; render(page: number, limits: OcrLimits, signal: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }>; close(): Promise<void> }
export type OcrDependencies = { open: (file: Blob, signal: AbortSignal) => Promise<OcrPdf>; engine: (language: OcrJob["language"], signal: AbortSignal, progress: (value: number) => void, dpi: number) => LocalOcrEngine };
const abortError = () => new DOMException("OCR cancelled", "AbortError");
function guarded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => reject(abortError()); signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function openOcrPdf(file: Blob, signal: AbortSignal): Promise<OcrPdf> {
  if (file.size > 20 * 1024 * 1024) throw new Error("OCR supports local PDFs up to 20 MiB.");
  const bytes = await guarded(file.arrayBuffer(), signal);
  const { getDocument, GlobalWorkerOptions, VerbosityLevel } = await guarded(import("pdfjs-dist"), signal);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, verbosity: VerbosityLevel.ERRORS, useWorkerFetch: false, useSystemFonts: false, useWasm: false, isEvalSupported: false, disableFontFace: true, disableAutoFetch: true, disableStream: true, disableRange: true });
  const abort = () => { void task.destroy(); }; signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await guarded(task.promise, signal);
    return { pageCount: pdf.numPages, close: async () => { signal.removeEventListener("abort", abort); await task.destroy(); }, render: async (number, limits, pageSignal) => {
      const page = await guarded(pdf.getPage(number), pageSignal);
      const viewport = page.getViewport({ scale: limits.dpi / 72 });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > limits.maxPixels) { page.cleanup(); throw new RangeError("Selected page exceeds the configured pixel/canvas limit. Lower DPI or choose a smaller page."); }
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) { canvas.width = 0; canvas.height = 0; page.cleanup(); throw new Error("Canvas rendering is unavailable."); }
      const rendering = page.render({ canvas, canvasContext: context, viewport });
      const cancel = () => rendering.cancel(); pageSignal.addEventListener("abort", cancel, { once: true });
      try {
        await guarded(rendering.promise, pageSignal);
        const png = await guarded(new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not render this page.")), "image/png")), pageSignal);
        if (png.size > 32 * 1024 * 1024) throw new RangeError("Rendered page exceeds the 32 MiB image limit.");
        return { bytes: new Uint8Array(await guarded(png.arrayBuffer(), pageSignal)), width, height };
      } finally { pageSignal.removeEventListener("abort", cancel); canvas.width = 0; canvas.height = 0; page.cleanup(); }
    } };
  } catch (error) { signal.removeEventListener("abort", abort); await task.destroy(); throw error; }
}

export function ocrQuality(output: OcrEngineOutput, page: number, width: number, height: number, maxCharacters: number): OcrPage {
  if (typeof output.text !== "string" || output.text.length > maxCharacters || !Number.isFinite(output.confidence)) throw new RangeError("OCR output exceeds supported limits.");
  if (output.confidence < 0 || output.confidence > 100) throw new RangeError("OCR confidence is outside supported limits.");
  const regions: OcrPage["regions"] = []; let regionCharacters = 0;
  for (const block of output.blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
    regionCharacters += line.text.length;
    if (regions.length >= 10_000 || regionCharacters > maxCharacters) throw new RangeError("OCR output exceeds supported limits.");
    const b = line.bbox; if (!b || ![b.x0, b.y0, b.x1, b.y1].every(Number.isFinite) || b.x0 < 0 || b.y0 < 0 || b.x1 > width || b.y1 > height || b.x1 < b.x0 || b.y1 < b.y0) continue;
    regions.push({ text: line.text, confidence: Number.isFinite(line.confidence) ? line.confidence : 0, bounds: [b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0] });
  }
  if (!regions.length && output.text.trim()) regions.push({ text: output.text, confidence: output.confidence, bounds: [0, 0, width, height] });
  const useful = output.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return { page, width, height, text: output.text, confidence: output.confidence, regions, status: output.confidence >= 70 && useful >= 4 ? "recognized" : "review_needed" };
}

export async function runOcr(file: Blob, selection: number[], language: OcrJob["language"], limits: OcrLimits, signal: AbortSignal, progress: (state: OcrProgress) => void, dependencies: OcrDependencies = { open: openOcrPdf, engine: createLocalOcrEngine }): Promise<OcrJob> {
  if (!["eng", "rus", "eng+rus"].includes(language)) throw new Error("Choose English, Russian or both.");
  if (!Number.isInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > 50 || !Number.isInteger(limits.dpi) || limits.dpi < 72 || limits.dpi > 180 || !Number.isInteger(limits.millisecondsPerPage) || limits.millisecondsPerPage < 1000 || limits.millisecondsPerPage > 120_000 || !Number.isInteger(limits.maxPixels) || limits.maxPixels < 1 || limits.maxPixels > 8_000_000 || !Number.isInteger(limits.maxCharacters) || limits.maxCharacters < 1 || limits.maxCharacters > 100_000) throw new Error("OCR limits are invalid. Use 1–50 pages, 72–180 DPI, 1–120 seconds and at most 8 million pixels/100,000 characters.");
  if (!selection.length || selection.length > limits.maxPages || new Set(selection).size !== selection.length || selection.some((page) => !Number.isSafeInteger(page) || page < 1)) throw new Error("Select unique positive page numbers within the configured page limit.");
  if (signal.aborted) throw abortError();
  const selectedPages = [...selection].sort((a, b) => a - b), pages: OcrPage[] = [];
  const job = (status: OcrJob["status"]): OcrJob => ({ selectedPages, pages: [...pages], complete: status === "complete", status, language, dpi: limits.dpi, engine: "tesseract.js-7.0.0" });
  const report = (currentPage?: number, currentProgress = 0) => progress({ total: selectedPages.length, completed: pages.filter((page) => page.status !== "failed").length, failed: pages.filter((page) => page.status === "failed").length, remaining: selectedPages.length - pages.length, currentPage, currentProgress, pages: [...pages] });
  let pdf: OcrPdf | undefined, engine: LocalOcrEngine | undefined;
  let currentProgress: ((value: number) => void) | undefined;
  const opening = new AbortController(); const cancelOpening = () => opening.abort(); signal.addEventListener("abort", cancelOpening, { once: true });
  const openingTimer = setTimeout(() => opening.abort(), limits.millisecondsPerPage);
  try {
    report(); pdf = await guarded(dependencies.open(file, opening.signal), opening.signal);
    clearTimeout(openingTimer); signal.removeEventListener("abort", cancelOpening);
    if (selectedPages.some((page) => page > pdf!.pageCount)) throw new Error("A selected page is outside this PDF. Check the original page numbers.");
    for (const page of selectedPages) {
      if (signal.aborted) return job("cancelled");
      const controller = new AbortController(); let timedOut = false;
      const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.millisecondsPerPage);
      report(page);
      currentProgress = (value) => { if (!controller.signal.aborted && !signal.aborted) report(page, value); };
      try {
        if (!pdf) pdf = await guarded(dependencies.open(file, controller.signal), controller.signal);
        const image = await guarded(pdf.render(page, limits, controller.signal), controller.signal);
        if (!engine) engine = dependencies.engine(language, signal, (value) => currentProgress?.(value), limits.dpi);
        await guarded(engine.ready, controller.signal);
        const output = await guarded(engine.recognize(image.bytes), controller.signal);
        if (signal.aborted || controller.signal.aborted) throw abortError();
        pages.push(ocrQuality(output, page, image.width, image.height, limits.maxCharacters));
      } catch (error) {
        engine?.terminate(); engine = undefined;
        if (signal.aborted) return job("cancelled");
        if (timedOut) { await pdf?.close(); pdf = undefined; }
        pages.push({ page, width: 0, height: 0, text: "", confidence: 0, regions: [], status: "failed", error: timedOut ? "Page timed out; rendering and OCR were stopped. Retry with a smaller page." : error instanceof RangeError ? "Page exceeds configured resource limits. Lower DPI or split the document." : "Local page OCR failed. Check local assets and retry this page." });
      } finally { currentProgress = undefined; clearTimeout(timer); signal.removeEventListener("abort", cancel); }
      report();
    }
    return job(pages.some((page) => page.status === "failed") ? "incomplete" : "complete");
  } catch (error) { if (signal.aborted) return job("cancelled"); throw error instanceof Error && /selected page|outside this PDF/.test(error.message) ? error : new Error("Could not open the local PDF within the time limit. Check local assets and retry."); }
  finally { clearTimeout(openingTimer); signal.removeEventListener("abort", cancelOpening); engine?.terminate(); await pdf?.close(); }
}
