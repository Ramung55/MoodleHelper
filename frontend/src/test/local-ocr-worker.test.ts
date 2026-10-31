import { afterEach, expect, it, vi } from "vitest";
import { createLocalOcrEngine } from "@/services/local-ocr-worker";
afterEach(() => vi.unstubAllGlobals());
it("uses only explicit same-origin worker/core/language paths, LSTM and sanitized errors", async () => {
  const messages: any[] = []; let instance: any;
  class FakeWorker {
    onmessage?: (event: any) => void; onerror?: (event: any) => void; terminate = vi.fn();
    constructor(public url: URL) { instance = this; }
    postMessage(message: any) { messages.push(message); queueMicrotask(() => this.onmessage?.({ data: { jobId: message.jobId, status: "resolve", data: message.action === "recognize" ? { text: "Exam", confidence: 90 } : {} } })); }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const engine = createLocalOcrEngine("eng+rus", new AbortController().signal, vi.fn(), 96); await engine.ready;
  expect(instance.url.href).toBe(`${window.location.origin}/ocr/7.0.0/local-worker.js`);
  expect(messages[0].payload.options).toMatchObject({ lstmOnly: true, corePath: `${window.location.origin}/ocr/7.0.0/core/`, logging: false });
  expect(messages[1].payload.options).toMatchObject({ langPath: `${window.location.origin}/ocr/7.0.0/lang/`, cacheMethod: "none", gzip: true });
  expect(messages[2].payload).toMatchObject({ oem: 1, config: { user_defined_dpi: "96" } });
  await engine.recognize(new Uint8Array([1,2])); engine.terminate(); expect(instance.terminate).toHaveBeenCalledOnce();
});
it("terminates immediately during initialization and rejects pending work without exposing worker errors", async () => {
  let instance: any;
  class FakeWorker { onmessage?: (event: any) => void; onerror?: (event: any) => void; terminate = vi.fn(); constructor() { instance = this; } postMessage() {} }
  vi.stubGlobal("Worker", FakeWorker); const controller = new AbortController();
  const engine = createLocalOcrEngine("eng", controller.signal, vi.fn()); controller.abort();
  await expect(engine.ready).rejects.toMatchObject({ name: "AbortError" }); expect(instance.terminate).toHaveBeenCalledOnce();
  const another = createLocalOcrEngine("eng", new AbortController().signal, vi.fn());
  instance.onerror({ preventDefault() {}, message: "private page bytes" });
  await expect(another.ready).rejects.toThrow(/Check installed assets/);
});
