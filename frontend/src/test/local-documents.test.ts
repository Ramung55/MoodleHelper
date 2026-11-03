import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLocalJobLease, currentDataset, saveLocalDocument, readLocalDocument } from "@/services/local-documents";
afterEach(() => vi.unstubAllGlobals());
describe("local dataset binding", () => {
  it.each(["valid", "missing association", "missing blob", "changed", "offline"])("scopes Blob reads and fails closed: %s", async (mode) => {
    const datasetId = "12345678-1234-4123-8123-123456789abc";
    const association = { datasetId, courseId: "course", digest: "digest", name: "local.pdf", size: 1, source: "local", createdAt: "now" };
    const file = new Blob(["local"]); const keys: unknown[] = []; let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      if (calls > 1 && mode === "offline") throw new Error("offline");
      return new Response(JSON.stringify({ datasetId: calls > 1 && mode === "changed" ? "87654321-4321-4321-8321-cba987654321" : datasetId }), { status: 200 });
    }));
    const close = vi.fn();
    const db = { close, transaction: (stores: string[], access: string) => {
      expect(stores).toEqual(["associations", "blobs"]); expect(access).toBe("readonly");
      const tx: any = { objectStore: (store: string) => ({ get: (key: unknown) => {
        keys.push(key);
        const request = { result: store === "associations" ? (mode === "missing association" ? undefined : association) : (mode === "missing blob" ? undefined : { file }) };
        return request;
      } }) };
      queueMicrotask(() => tx.oncomplete()); return tx;
    } };
    vi.stubGlobal("indexedDB", { open: () => { const request: any = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } });
    const read = readLocalDocument(association, new AbortController().signal);
    if (mode === "valid") expect(await read).toBe(file); else await expect(read).rejects.toThrow(/unavailable|changed|offline/);
    expect(keys).toEqual([[datasetId, "course", "digest"], [datasetId, "digest"]]); expect(close).toHaveBeenCalledOnce();
  });
  it("requests only the opaque context without credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ datasetId: "12345678-1234-4123-8123-123456789abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await currentDataset()).toBe("12345678-1234-4123-8123-123456789abc");
    expect(fetcher).toHaveBeenCalledWith("/api/local-context", expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store" }));
  });
  it("passes a caller abort signal to context verification without changing its wire request", async () => {
    const controller = new AbortController(); const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ datasetId: "12345678-1234-4123-8123-123456789abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher); await currentDataset(controller.signal);
    expect(fetcher).toHaveBeenCalledWith("/api/local-context", expect.objectContaining({ method: "GET", credentials: "omit", signal: controller.signal }));
  });
  it("fails closed on invalid or extra context data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ datasetId: "bad", namespace: "secret" }), { status: 200 })));
    await expect(currentDataset()).rejects.toThrow(/invalid/);
  });
  it("does not open storage after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(saveLocalDocument({ datasetId: "d", courseId: "c", digest: "x", name: "a", size: 1, source: "local", createdAt: "now" }, new Blob(), [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("holds a per-attempt browser lock until released, so a live attempt cannot be recovered", async () => {
    const active = new Set<string>();
    const locks = { request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      if (active.has(name)) return callback(null);
      active.add(name); try { await callback({ name }); } finally { active.delete(name); }
    } };
    vi.stubGlobal("navigator", { locks });
    const job = { datasetId: "d", owner: "tab", id: "attempt", name: "x", courseId: "c", state: "queued" as const, message: "", leaseVersion: 1 as const };
    const release = await acquireLocalJobLease(job);
    await expect(acquireLocalJobLease(job)).rejects.toThrow(/already active/);
    release();
    await vi.waitFor(() => expect(active.size).toBe(0));
    const releaseAgain = await acquireLocalJobLease(job); releaseAgain();
  });
  it("fails closed when Web Locks is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(acquireLocalJobLease({ datasetId: "d", owner: "tab", id: "attempt", name: "x", courseId: "c", state: "queued", message: "" })).rejects.toThrow(/Web Locks/);
  });
});
