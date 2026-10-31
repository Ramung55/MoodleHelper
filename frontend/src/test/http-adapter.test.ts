import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDemoSnapshot } from "@/services/fixtures";
import { HttpAdapter } from "@/services/http-adapter";
import { getAdapter } from "@/services";

const snapshot = buildDemoSnapshot();
const connection = { state: "demo", extensionDetected: false, message: "Local fictional backend" };
const input = { courseId: "c-csc", title: "Study", type: "other" as const, date: { kind: "week" as const, week: 8 } };
const fetcher = vi.fn<typeof fetch>();
const api = new HttpAdapter("http://127.0.0.1:8000/", fetcher);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => fetcher.mockReset());
const context = { datasetId: "12345678-1234-4123-8123-123456789abc", epoch: 3, revision: 7, lifecycle: "active" };

describe("#56 data-lifecycle epoch", () => {
  it("reads the epoch before the Snapshot and attaches it to writes, never to reads", async () => {
    const adapter = new HttpAdapter("", fetcher);
    fetcher.mockResolvedValueOnce(response(context)).mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response(connection));
    expect(await adapter.load()).toEqual(snapshot);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/data-context", "/api/snapshot"]);
    await adapter.updateSettings({ semesterWeeks: 9 });
    expect((fetcher.mock.calls[2]![1]!.headers as Record<string, string>)["X-Moodle-Helper-Data-Epoch"]).toBe("3");
    await adapter.connection();
    expect((fetcher.mock.calls[3]![1]!.headers as Record<string, string>)["X-Moodle-Helper-Data-Epoch"]).toBeUndefined();
  });
  it("keeps legacy behaviour (no header) when the context is unavailable", async () => {
    const adapter = new HttpAdapter("", fetcher);
    fetcher.mockResolvedValueOnce(response({ message: "x" }, 404)).mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response(snapshot));
    await adapter.load(); await adapter.updateSettings({ semesterWeeks: 9 });
    expect((fetcher.mock.calls[2]![1]!.headers as Record<string, string>)["X-Moodle-Helper-Data-Epoch"]).toBeUndefined();
  });
  it("erases with the process binding, adopts the new epoch and reports an unknown outcome on network loss", async () => {
    const adapter = new HttpAdapter("", fetcher);
    const cleanup = { backend: "complete", dashboard: "pending", extension: "pending" };
    const request = { idempotencyKey: "erase-key-1", expectedDatasetId: context.datasetId, expectedEpoch: 3, expectedRevision: 7 };
    fetcher.mockResolvedValueOnce(response({ version: "1", binding: "b1" })).mockResolvedValueOnce(response({ eraseId: "e".repeat(32), datasetId: context.datasetId, epoch: 4, revision: 8, snapshot, cleanup }))
      .mockResolvedValueOnce(response(snapshot));
    expect((await adapter.eraseLocalData(request)).epoch).toBe(4);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe("/api/local-data/erase");
    expect(JSON.parse(String(init!.body))).toEqual(request);
    expect((init!.headers as Record<string, string>)["X-Moodle-Helper-Bridge-Binding"]).toBe("b1");
    await adapter.updateSettings({ semesterWeeks: 9 });
    expect((fetcher.mock.calls[2]![1]!.headers as Record<string, string>)["X-Moodle-Helper-Data-Epoch"]).toBe("4");
    fetcher.mockResolvedValueOnce(response({ version: "1", binding: "b1" })).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(adapter.eraseLocalData(request)).rejects.toMatchObject({ name: "EraseOutcomeUnknown" });
  });
});

describe("HTTP request mappings", () => {
  const cases = [
    ["GET", "/connection", undefined, connection, () => api.connection()],
    ["PUT", "/snapshot", snapshot, snapshot, () => api.replaceAll(snapshot)],
    ["PUT", "/tracked-courses", [], snapshot, () => api.setTrackedCourses([])],
    ["PATCH", "/assessments/a1/overlay", { completed: true }, snapshot, () => api.updateOverlay("a1", { completed: true })],
    ["POST", "/personal-events", input, snapshot, () => api.addPersonalEvent(input)],
    ["DELETE", "/personal-events/p1", undefined, snapshot, () => api.deletePersonalEvent("p1")],
    ["POST", "/sync", undefined, snapshot, () => api.syncAll(() => {})],
    ["POST", "/documents/import", { courseId: "c-csc", fileName: "syllabus.pdf" }, { snapshot, result: { ok: true } }, () => api.importDocument("c-csc", "syllabus.pdf", () => {})],
    ["POST", "/candidates/k1/review", { kind: "confirm" }, snapshot, () => api.review("k1", { kind: "confirm" })],
    ["POST", "/materials/m1/download", undefined, { snapshot, supported: false, message: "Needs extension" }, () => api.downloadMaterial("m1")],
    ["PUT", "/alerts", [], snapshot, () => api.saveAlerts([])],
    ["PATCH", "/settings", { semesterWeeks: 16 }, snapshot, () => api.updateSettings({ semesterWeeks: 16 })],
    ["DELETE", "/local-data", undefined, snapshot, () => api.deleteLocalData()],
    ["POST", "/demo/reset", undefined, snapshot, () => api.resetDemo()],
    ["GET", "/ai/availability", undefined, { available: false, reason: "Unconfigured" }, () => api.aiAvailability()],
  ] as const;

  it.each(cases)("%s %s matches the contract", async (method, path, body, result, call) => {
    fetcher.mockResolvedValueOnce(response(result));
    expect(await call()).toEqual(result);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:8000/api${path}`);
    expect(init?.method).toBe(method);
    expect(init?.credentials).toBe("omit");
    expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
  });

  it("defaults to HTTP without a localStorage fallback", () => {
    expect(getAdapter()).toBeInstanceOf(HttpAdapter);
    expect(getAdapter().storage).toBe("backend");
  });

  it("encodes identifiers and converts explicit undefined clears to null", async () => {
    fetcher.mockImplementation(async () => response(snapshot));
    await api.updateOverlay("a/b ?#%", { titleOverride: undefined, dateOverride: undefined });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/api/assessments/a%2Fb%20%3F%23%25/overlay");
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ titleOverride: null, dateOverride: null });
    await api.deletePersonalEvent("p ?");
    await api.review("k #", { kind: "reject" });
    fetcher.mockResolvedValueOnce(response({ snapshot, supported: false, message: "Needs extension" }));
    await api.downloadMaterial("m %");
    expect(fetcher.mock.calls[1]?.[0]).toContain("p%20%3F");
    expect(fetcher.mock.calls[2]?.[0]).toContain("k%20%23");
    expect(fetcher.mock.calls[3]?.[0]).toContain("m%20%25");
  });

  it("keeps omission distinct from explicit clearing", async () => {
    fetcher.mockResolvedValue(response(snapshot));
    await api.updateOverlay("a1", { hidden: true });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ hidden: true });
  });
});

describe("HTTP outcomes", () => {
  it("invokes progress only once with the final validated snapshot", async () => {
    fetcher.mockResolvedValueOnce(response(snapshot)).mockResolvedValueOnce(response({ snapshot, result: { ok: true } }));
    const sync = vi.fn();
    const imported = vi.fn();
    await api.syncAll(sync);
    await api.importDocument("c-csc", "f.pdf", imported);
    expect(sync).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(imported).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it("preserves unsupported import/download and AI outcomes", async () => {
    fetcher.mockResolvedValueOnce(response({ snapshot, result: { ok: false, reason: "Unsupported" } }));
    expect((await api.importDocument("c", "f.doc", () => {})).result).toEqual({ ok: false, reason: "Unsupported" });
  });

  it("surfaces backend messages and network failures", async () => {
    fetcher.mockResolvedValueOnce(response({ message: "Invalid semester" }, 422));
    await expect(api.updateSettings({ semesterWeeks: 99 })).rejects.toThrow("Invalid semester");
    fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.load()).rejects.toThrow("Could not reach the local backend");
  });

  it("reports unavailable live sync without emitting a progress snapshot", async () => {
    const message = "Live course sync is unavailable until Moodle access is verified.";
    fetcher.mockResolvedValueOnce(response({ message }, 503));
    const progress = vi.fn();
    await expect(api.syncAll(progress)).rejects.toThrow(message);
    expect(progress).not.toHaveBeenCalled();
  });

  it("rejects malformed successful payloads and never calls progress", async () => {
    fetcher.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response(context)).mockResolvedValueOnce(new Response("<html>error</html>"));
    const progress = vi.fn();
    await expect(api.syncAll(progress)).rejects.toThrow("invalid response");
    expect(progress).not.toHaveBeenCalled();
    await expect(api.load()).rejects.toThrow("invalid JSON");
  });

  it("uses a useful fallback for non-JSON or malformed HTTP errors", async () => {
    fetcher.mockResolvedValueOnce(response(context)).mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(response(context)).mockResolvedValueOnce(response({}, 500));
    await expect(api.load()).rejects.toThrow("HTTP 503");
    await expect(api.load()).rejects.toThrow("HTTP 500");
  });
});
