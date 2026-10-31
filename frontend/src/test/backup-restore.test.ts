import { describe, expect, it, vi } from "vitest";
import { buildBackup, MAX_BACKUP_BYTES, previewRestore, readBackupFile } from "@/domain/backup";
import { HttpAdapter } from "@/services/http-adapter";
import { RestoreOutcomeUnknown } from "@/services/adapter";
import { buildDemoSnapshot } from "@/services/fixtures";

const ID = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const demo = () => buildDemoSnapshot(Date.UTC(2026, 9, 24, 9));

describe("backup restore preview (#55)", () => {
  it("shows version, counts, exclusions and is restorable only with matching identity", () => {
    const snap = demo();
    const { json } = buildBackup(snap, ID);
    const p = previewRestore(json, snap, ID);
    expect(p).toMatchObject({ ok: true, identity: "match", restorable: true, settingsReplaced: true, overlaysReplaced: true });
    if (!p.ok) throw new Error();
    expect(p.backup.version).toBe(1);
    expect(p.diff.find((d) => d.label === "Personal changes")!.incoming).toBe(snap.overlays.length);
    expect(p.exclusions.join(" ")).toMatch(/PDF\/DOCX/);
    expect(p.exclusions.join(" ")).toMatch(/downloaded/);
  });

  it("rejects wrong identity, future version and unsafe/expiring links with specific messages", () => {
    const snap = demo();
    const { json } = buildBackup(snap, ID);
    expect(previewRestore(json, snap, ID2)).toMatchObject({ ok: false, error: expect.stringMatching(/Wrong identity/) });
    expect(previewRestore(JSON.stringify({ ...JSON.parse(json), version: 2 }), snap, ID)).toMatchObject({ ok: false, error: expect.stringMatching(/newer/) });
    const data = JSON.parse(json);
    data.data.materials[0].url = "https://files.example/doc.pdf?X-Amz-Expires=300";
    expect(previewRestore(JSON.stringify(data), snap, ID)).toMatchObject({ ok: false, error: expect.stringMatching(/expiring/) });
    expect(previewRestore("{", snap, ID)).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) });
    expect(previewRestore("[".repeat(80) + "]".repeat(80), snap, ID)).toMatchObject({ ok: false });
  });

  it("previews identity-less historical v1 as not restorable", () => {
    const snap = demo();
    const legacy = { app: "moodle-helper", version: 1, exportedAt: "2026-01-01T00:00:00.000Z", note: "", data: snap };
    expect(previewRestore(JSON.stringify(legacy), snap, ID)).toMatchObject({ ok: true, identity: "unavailable", restorable: false, reason: expect.stringMatching(/Identity unavailable/) });
  });

  it("checks size before reading and rejects malformed UTF-8", async () => {
    const big = { size: MAX_BACKUP_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    expect(await readBackupFile(big)).toMatchObject({ ok: false, error: expect.stringMatching(/20 MiB/) });
    expect((big as unknown as { arrayBuffer: ReturnType<typeof vi.fn> }).arrayBuffer).not.toHaveBeenCalled();
    expect(await readBackupFile(new Blob([new Uint8Array([0x7b, 0xff, 0x7d])]))).toMatchObject({ ok: false, error: expect.stringMatching(/UTF-8/) });
    expect(await readBackupFile(new Blob(["{}"]))).toEqual({ ok: true, text: "{}" });
  });
});

describe("HTTP restore adapter (#55)", () => {
  const request = { idempotencyKey: "restore-abcdefgh", expectedDatasetId: ID, expectedEpoch: 0, expectedRevision: 3, backup: {} };
  const bridge = () => new Response(JSON.stringify({ version: "1", binding: "b1" }));

  it("sends the binding and exact preconditions", async () => {
    const snapshot = demo();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/bridge-context")) return bridge();
      expect(url).toBe("/api/backups/restore");
      expect((init!.headers as Record<string, string>)["X-Moodle-Helper-Bridge-Binding"]).toBe("b1");
      expect(JSON.parse(init!.body as string)).toEqual(request);
      return new Response(JSON.stringify({ snapshot, datasetId: ID, epoch: 1, revision: 4, restoreId: "r", remindersRebuilt: true, reminderGeneration: "g-1", replayed: false }));
    });
    const result = await new HttpAdapter("", fetcher as unknown as typeof fetch).restoreBackup(request);
    expect(result.epoch).toBe(1);
  });

  it("reports unknown outcome on response loss and a definite failure on rejection", async () => {
    const lost = vi.fn(async (url: string) => { if (url.endsWith("/bridge-context")) return bridge(); throw new TypeError("network"); });
    await expect(new HttpAdapter("", lost as unknown as typeof fetch).restoreBackup(request)).rejects.toBeInstanceOf(RestoreOutcomeUnknown);
    const stale = vi.fn(async (url: string) => url.endsWith("/bridge-context") ? bridge() : new Response(JSON.stringify({ message: "Local data changed since the restore preview." }), { status: 409 }));
    await expect(new HttpAdapter("", stale as unknown as typeof fetch).restoreBackup(request)).rejects.toThrow(/changed since/);
  });
});
