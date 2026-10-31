import { afterEach, describe, expect, it, vi } from "vitest";
import { Backup, buildBackup, BackupSanitizeError, dispatchDownload, prepareBackup, previewRestore, unsafeUrlReason } from "@/domain/backup";
import type { Snapshot } from "@/domain/types";
import { buildDemoSnapshot } from "@/services/fixtures";

const ID = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const demo = () => buildDemoSnapshot(Date.UTC(2026, 9, 24, 9));
const empty = (): Snapshot => ({ ...demo(), courses: [], assessments: [], overlays: [], materials: [], documents: [], candidates: [], sync: [], changes: [], alerts: [] });

afterEach(() => vi.restoreAllMocks());

describe("backup export (#45)", () => {
  it("includes datasetId, version and counts derived from the same frozen object as the bytes", () => {
    const snap = demo();
    const p = buildBackup(snap, ID, new Date("2026-10-31T10:00:00Z"));
    const parsed = Backup.parse(JSON.parse(p.json));
    expect(parsed.datasetId).toBe(ID);
    expect(parsed.version).toBe(1);
    expect(parsed.summary!.counts).toEqual(p.backup.summary!.counts);
    expect(parsed.summary!.counts.find((c) => c.label === "Courses")!.count).toBe(snap.courses.length);
    expect(parsed.summary!.exclusions.join(" ")).toMatch(/PDF\/DOCX/);
    expect(p.bytes).toBe(new TextEncoder().encode(p.json).length);
    expect(Object.isFrozen(p.backup.data.courses)).toBe(true);
    expect(parsed.data.overlays).toEqual(snap.overlays);
    expect(previewRestore(p.json, snap).ok).toBe(true);
  });

  it("does not change when live data mutates after preparation", () => {
    const snap = demo();
    const p = buildBackup(snap, ID);
    const before = p.json;
    snap.courses.push({ ...snap.courses[0], id: "late" });
    expect(p.json).toBe(before);
    expect(p.backup.data.courses.some((c) => c.id === "late")).toBe(false);
  });

  it("exports an empty snapshot with zero counts", () => {
    const p = buildBackup(empty(), ID);
    expect(p.backup.summary!.counts.every((c) => c.count === 0)).toBe(true);
  });

  it("legacy v1 backups without identity remain readable", () => {
    const legacy = { app: "moodle-helper", version: 1, exportedAt: "x", note: "n", data: demo() };
    expect(previewRestore(JSON.stringify(legacy), demo()).ok).toBe(true);
    expect(previewRestore(JSON.stringify({ ...legacy, version: 2 }), demo())).toMatchObject({ ok: false });
  });

  it("projects out unknown extension fields", () => {
    const snap = { ...demo(), providerApiKey: "x", bridgeToken: "y" } as unknown;
    const p = buildBackup(snap, ID);
    expect(p.json).not.toContain("providerApiKey");
    expect(p.json).not.toContain("bridgeToken");
  });

  it("rejects nested credential-bearing URLs and secrets without echoing them", () => {
    const signed = "https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=SECRETSIG123&X-Amz-Credential=c";
    const snap = demo();
    snap.materials[0] = { ...snap.materials[0], url: signed } as typeof snap.materials[0];
    snap.courses[0] = { ...snap.courses[0], name: "Notes sk-ant-abcdefghijklmnopqrstuv" };
    let err: unknown;
    try { buildBackup(snap, ID); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BackupSanitizeError);
    const msg = (err as Error).message;
    expect(msg).not.toContain("SECRETSIG123");
    expect(msg).not.toContain("abcdefghijklmnop");
    expect(msg).toMatch(/data\.materials\[0\]/);
  });

  it("classifies URLs", () => {
    expect(unsafeUrlReason("https://moodle.example.edu/mod/assign/view.php?id=42")).toBeNull();
    expect(unsafeUrlReason("https://u:p@moodle.example.edu/x")).toMatch(/credentials/);
    expect(unsafeUrlReason("https://m.example.edu/webservice/pluginfile.php/1/f.pdf?token=abc")).toMatch(/token/);
    expect(unsafeUrlReason("https://m.example.edu/login/index.php")).toMatch(/login/);
    expect(unsafeUrlReason("javascript:alert(1)")).toMatch(/scheme/);
    expect(unsafeUrlReason("https://m.example.edu/x?sesskey=abc")).toMatch(/session/);
    expect(unsafeUrlReason("Week 3: intro")).toBeNull();
  });

  it("aborts on changed or unavailable dataset identity and on read failure", async () => {
    const ids = [ID, ID2];
    await expect(prepareBackup(async () => demo(), async () => ids.shift()!)).rejects.toThrow(/dataset changed/);
    await expect(prepareBackup(async () => demo(), async () => { throw new Error("Could not identify the current dataset."); })).rejects.toThrow(/identify/);
    await expect(prepareBackup(async () => { throw new Error("offline"); }, async () => ID)).rejects.toThrow(/Could not read local data/);
    await expect(prepareBackup(async () => ({ junk: true }), async () => ID)).rejects.toThrow(/validation/);
    const load = vi.fn(async () => demo());
    const p = await prepareBackup(load, async () => ID);
    expect(load).toHaveBeenCalledTimes(1);
    expect(p.backup.datasetId).toBe(ID);
  });

  it("dispatches a download, revokes later, and revokes on dispatch failure", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:x"); const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const p = buildBackup(empty(), ID);
    const stop = dispatchDownload(p);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledTimes(1);
    stop();
    expect(revoke).toHaveBeenCalledTimes(1);
    click.mockImplementation(() => { throw new Error("blocked"); });
    expect(() => dispatchDownload(p)).toThrow("blocked");
    expect(revoke).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
