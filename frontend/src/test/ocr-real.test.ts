// @vitest-environment node
import path from "node:path";
import { readFileSync } from "node:fs";
import { createWorker, OEM } from "tesseract.js";
import { expect, it } from "vitest";
import { ocrQuality } from "@/services/ocr-pdf";
import { detectAssessmentMentions } from "@/domain/assessment-mentions";

it("recognizes real EN/RU scanned images and flags unreadable output using only installed local assets with network denied", async () => {
  const worker = await createWorker("eng+rus", OEM.LSTM_ONLY, {
    workerPath: path.resolve("src/test/fixtures/ocr-network-disabled-worker.cjs"),
    corePath: path.resolve("public/ocr/7.0.0/core"), langPath: path.resolve("public/ocr/7.0.0/lang"),
    gzip: true, cacheMethod: "none", logger: () => {}, errorHandler: () => {},
  });
  try {
    const english = (await worker.recognize(readFileSync("src/test/fixtures/ocr-eng.png"), {}, { text: true, blocks: true })).data;
    const russian = (await worker.recognize(readFileSync("src/test/fixtures/ocr-rus.png"), {}, { text: true, blocks: true })).data;
    const unreadable = (await worker.recognize(readFileSync("src/test/fixtures/ocr-unreadable.png"), {}, { text: true, blocks: true })).data;
    expect(english.text).toMatch(/Assignment 1/i); expect(russian.text).toMatch(/Экзамен/iu);
    const pages = [ocrQuality(english, 2, 1100, 320, 100_000), ocrQuality(russian, 7, 1100, 320, 100_000), ocrQuality(unreadable, 9, 1100, 320, 100_000)];
    expect(pages[2]!.status).toBe("review_needed");
    const mentions = await detectAssessmentMentions({ format: "ocr", datasetId: "fixture", courseId: "course", digest: "scan", complete: true, status: "complete", selectedPages: [2,7,9], language: "eng+rus", dpi: 120, engine: "tesseract.js-7.0.0", pages }, new AbortController().signal);
    expect(mentions.some((mention) => mention.type === "exam" && mention.location.kind === "ocr_region" && mention.location.page === 7 && !mention.location.synthetic)).toBe(true);
    expect(mentions.every((mention) => mention.status === "unconfirmed" && mention.date.kind === "unknown")).toBe(true);
  } finally { await worker.terminate(); }
}, 120_000);
