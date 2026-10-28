import { getDocument, GlobalWorkerOptions, OPS, VerbosityLevel } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExtractedPage, TextEvidence, TextRow } from "@/domain/local-extraction";
import { validatePdf } from "./validate-pdf";

export const PDF_EXTRACTION_LIMITS = { bytes: 20 * 1024 * 1024, pages: 100, items: 100_000, characters: 1_000_000 };
const cancelled = () => new DOMException("Extraction cancelled", "AbortError");

/** Group only horizontal text on near-equal baselines; retain original geometry. */
export function pdfRows(items: TextEvidence[]): TextRow[] {
  const rows: TextEvidence[][] = [];
  for (const item of [...items].sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!)) {
    const horizontal = Math.abs(item.transform[1]!) < 0.01 && Math.abs(item.transform[2]!) < 0.01;
    const row = horizontal && rows.find((group) => Math.abs(group[0]!.transform[5]! - item.transform[5]!) <= 3 && Math.abs(group[0]!.transform[1]!) < 0.01 && Math.abs(group[0]!.transform[2]!) < 0.01);
    if (row) row.push(item); else rows.push([item]);
  }
  return rows.map((group) => ({ text: group.map((item) => item.text).join(" "), items: group }));
}

export async function extractPdf(blob: Blob, signal: AbortSignal, progress: (page: number, total: number) => void): Promise<ExtractedPage[]> {
  const check = () => { if (signal.aborted) throw cancelled(); };
  check();
  if (blob.size > PDF_EXTRACTION_LIMITS.bytes) throw new Error("PDF extraction supports files up to 20 MiB.");
  const bytes = await blob.arrayBuffer(); check();
  // Validation transfers its own bytes to PDF.js; extraction needs a fresh copy.
  await validatePdf(bytes.slice(0), signal, PDF_EXTRACTION_LIMITS.pages); check();
  GlobalWorkerOptions.workerSrc = workerUrl;
  const task = getDocument({ data: new Uint8Array(bytes.slice(0)), stopAtErrors: true, verbosity: VerbosityLevel.ERRORS,
    useWorkerFetch: false, useSystemFonts: false, useWasm: false, isEvalSupported: false,
    disableFontFace: true, disableAutoFetch: true, disableStream: true, disableRange: true });
  const abort = () => { void task.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check(); const pdf = await task.promise; check();
    if (pdf.numPages < 1 || pdf.numPages > PDF_EXTRACTION_LIMITS.pages) throw new Error("PDF extraction supports 1–100 pages. Split the document and retry.");
    const pages: ExtractedPage[] = []; let itemCount = 0, characters = 0;
    progress(0, pdf.numPages);
    for (let number = 1; number <= pdf.numPages; number++) {
      check(); const page = await pdf.getPage(number); check();
      try {
        const content = await page.getTextContent({ disableNormalization: true }); check();
        itemCount += content.items.length;
        if (itemCount > PDF_EXTRACTION_LIMITS.items) throw new Error("The PDF has too many text items. Split it and retry.");
        const items: TextEvidence[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          characters += item.str.length;
          if (characters > PDF_EXTRACTION_LIMITS.characters) throw new Error("The PDF exceeds the one-million-character extraction limit. Split it and retry.");
          if (!item.str.trim()) continue;
          if (item.transform.length !== 6 || !item.transform.every(Number.isFinite) || !Number.isFinite(item.width) || !Number.isFinite(item.height)) throw new Error("The PDF has unsupported text geometry.");
          items.push({ text: item.str, page: number, transform: [...item.transform], width: item.width, height: item.height });
        }
        const viewport = page.getViewport({ scale: 1 });
        let status: ExtractedPage["status"] = "text";
        if (!items.length) {
          const operators = await page.getOperatorList(); check();
          const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup]);
          if (operators.fnArray.some((operator) => images.has(operator))) status = "ocr_needed";
          else if (operators.fnArray.every((operator) => new Set([OPS.save, OPS.restore, OPS.transform, OPS.beginText, OPS.endText, OPS.dependency, OPS.setFont, OPS.setLeading, OPS.setTextMatrix, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setHScale, OPS.setTextRise]).has(operator))) status = "blank";
          else throw new Error(`Page ${number} contains drawing content without readable text or a recognized image. This page structure is unsupported.`);
        }
        pages.push({ page: number, width: viewport.width, height: viewport.height, status, rows: pdfRows(items) });
        check(); progress(number, pdf.numPages);
      } finally { page.cleanup(); }
    }
    check(); return pages;
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (error instanceof Error && error.name === "PasswordException") throw new Error("Password-protected PDFs are unsupported. Export an unencrypted copy.");
    throw error instanceof Error ? error : new Error("Could not extract this PDF. Export a supported unencrypted copy and retry.");
  } finally { signal.removeEventListener("abort", abort); await task.destroy(); }
}
