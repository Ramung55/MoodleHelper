/** Native ownership permits immediate termination even while v7 initializes. */
export const OCR_ASSET_BASE = "/ocr/7.0.0";
export type OcrEngineOutput = { text: string; confidence: number; blocks?: { paragraphs?: { lines?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }[] }[] };
export interface LocalOcrEngine { ready: Promise<void>; recognize(image: Uint8Array): Promise<OcrEngineOutput>; terminate(): void }

export function createLocalOcrEngine(language: "eng" | "rus" | "eng+rus", signal: AbortSignal, progress: (value: number) => void, dpi = 120): LocalOcrEngine {
  if (!["eng", "rus", "eng+rus"].includes(language)) throw new Error("Choose English, Russian or both.");
  if (signal.aborted) throw new DOMException("OCR cancelled", "AbortError");
  const base = new URL(OCR_ASSET_BASE + "/", window.location.origin);
  const worker = new Worker(new URL("local-worker.js", base));
  let closed = false, sequence = 0;
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  const terminate = () => {
    if (closed) return; closed = true; worker.terminate(); signal.removeEventListener("abort", terminate);
    for (const task of pending.values()) task.reject(signal.aborted ? new DOMException("OCR cancelled", "AbortError") : new Error("Local OCR stopped. Check installed assets and retry."));
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    if (closed || !data || typeof data.jobId !== "string") return;
    const task = pending.get(data.jobId); if (!task) return;
    if (data.status === "progress") { if (Number.isFinite(data.data?.progress)) progress(Math.max(0, Math.min(1, data.data.progress))); }
    else if (data.status === "resolve") { pending.delete(data.jobId); task.resolve(data.data); }
    else if (data.status === "reject") { pending.delete(data.jobId); task.reject(new Error("Local OCR failed. Verify installed local assets and retry.")); }
  };
  worker.onerror = (event) => { event.preventDefault(); terminate(); };
  signal.addEventListener("abort", terminate, { once: true });
  const request = (action: string, payload: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal.aborted || closed) { reject(new DOMException("OCR cancelled", "AbortError")); return; }
    const jobId = `ocr-${++sequence}`; pending.set(jobId, { resolve, reject });
    worker.postMessage({ workerId: "local-ocr", jobId, action, payload });
  });
  const ready = (async () => {
    await request("load", { options: { lstmOnly: true, corePath: new URL("core/", base).href, logging: false } });
    await request("loadLanguage", { langs: language, options: { langPath: new URL("lang/", base).href, gzip: true, cacheMethod: "none", lstmOnly: true } });
    await request("initialize", { langs: language, oem: 1, config: { user_defined_dpi: String(dpi) } });
  })();
  return { ready, terminate, recognize: async (image) => { await ready; return await request("recognize", { image, options: { rotateAuto: false }, output: { text: true, blocks: true } }) as OcrEngineOutput; } };
}
