import { afterEach, describe, expect, it, vi } from "vitest";
import { currentDataset, saveLocalDocument } from "@/services/local-documents";
afterEach(() => vi.unstubAllGlobals());
describe("local dataset binding", () => {
  it("requests only the opaque context without credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ datasetId: "12345678-1234-4123-8123-123456789abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await currentDataset()).toBe("12345678-1234-4123-8123-123456789abc");
    expect(fetcher).toHaveBeenCalledWith("/api/local-context", expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store" }));
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
});
