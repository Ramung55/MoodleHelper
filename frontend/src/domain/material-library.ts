import { safeDestination, unsafeLabel } from "../../../extension/src/moodle-materials";
import { SDU_ORIGIN, safeSourceHref } from "./deadline-display";
import type { Material, NormalizedMaterialRecord, PageRefreshReceipt, RawMaterialObservation, Snapshot } from "./types";

/**
 * Read-only course materials library view (#40). Derived from the collected
 * #17 NormalizedMaterialRecord observations plus the legacy Material list; it is
 * a view, never another storage authority, and never rewrites raw facts.
 */
export type LibraryType = "pdf" | "docx" | "pptx" | "link" | "video" | "other" | "folder" | "unknown";
export const LIBRARY_TYPES: LibraryType[] = ["pdf", "docx", "pptx", "link", "video", "other", "folder", "unknown"];
export const TYPE_LABEL: Record<LibraryType, string> = { pdf: "PDF", docx: "DOCX", pptx: "PPTX", link: "LINK", video: "VIDEO", other: "OTHER", folder: "FOLDER", unknown: "UNKNOWN TYPE" };

export interface LibraryLink { href: string | null; external: boolean; reason?: string }
export interface LibraryItem {
  /** Stable view key: provenance + normalized record / legacy ID. */
  key: string;
  recordId: string;
  provenance: "collected" | "legacy";
  courseId: string;
  sourceCourseId?: string;
  resourceKey?: string;
  parentResourceKey?: string;
  kind: "file" | "link" | "folder";
  title: string;
  titleKnown: boolean;
  section: string | null;
  type: LibraryType;
  mimeType: string | null;
  source: LibraryLink;
  destination: LibraryLink | null;
  listing?: { scope?: "reference_only" | "supplied_listing_only"; coverage?: "complete" | "partial" | "none" };
  /** Last successful observation; null when its timestamp is invalid. */
  lastObservedAt: string | null;
  access: "not_verified" | "legacy_accessible" | "legacy_inaccessible";
  stale: boolean;
  downloadedAt?: string;
  warnings: string[];
  /** Ancestor folder titles, nearest last; set when the parent chain resolves. */
  breadcrumb: string[];
  parentUnavailable: boolean;
  children: string[];
}

const SAFE_REASONS = new Set(["access_error", "collector_failed", "collector_unavailable", "collection_disabled", "pagination_pending", "incomplete_list", "folder_contents_uninspected", "persistence_failed", "unsupported_page"]);
const time = (v: unknown): number | null => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
/** Unicode normalization used by search: NFKC, Russian-aware lowercase, collapsed whitespace, ё→е. */
export const normalizeSearch = (v: string) => v.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();

function safeLabel(v: string): string | null {
  const t = v.trim();
  return t && t.length <= 300 && !/[<>\u0000-\u001f]/u.test(t) && !unsafeLabel(t) && !/(?:token|sesskey|password|authorization)\s*[=:]/iu.test(t) ? t : null;
}

function sourceLink(o: RawMaterialObservation): LibraryLink {
  const expected = `${SDU_ORIGIN}/mod/${o.sourceModuleType}/view.php?id=${o.sourceCourseModuleId}`;
  return o.sourceUrl === expected && safeSourceHref(o.sourceUrl) === expected ? { href: expected, external: false } : { href: null, external: false, reason: "Source link failed the safety check" };
}

function destinationLink(o: RawMaterialObservation): LibraryLink | null {
  const value = o.destinationUrl;
  if (value === undefined) return null;
  const blocked = { href: null, external: false, reason: "Destination link failed the safety check" };
  if (typeof value !== "string") return blocked;
  if (o.kind === "folder" && o.parentResourceKey) {
    return o.sourceFolderId && value === `${SDU_ORIGIN}/mod/folder/view.php?id=${o.sourceCourseModuleId}&folder=${o.sourceFolderId}` ? { href: value, external: false } : blocked;
  }
  const r = safeDestination(value, o.sourceModuleType, !!o.parentResourceKey);
  if (r.url !== value || (r.contextId && o.sourceContextId && r.contextId !== o.sourceContextId) || (r.contextId && !o.sourceContextId && o.parentResourceKey)) return blocked;
  return { href: value, external: !value.startsWith(`${SDU_ORIGIN}/`) };
}

const typeOf = (o: RawMaterialObservation): LibraryType => o.kind === "folder" ? "folder" : o.fileType.kind === "known" ? o.fileType.value : "unknown";
const sig = (o: RawMaterialObservation) => JSON.stringify(o);

function fromRecord(r: NormalizedMaterialRecord): LibraryItem {
  const timed = r.observations.map((o) => ({ o, t: time(o.observedAt) }));
  const valid = timed.filter((x) => x.t !== null) as { o: RawMaterialObservation; t: number }[];
  const warnings: string[] = [];
  let latest: RawMaterialObservation[];
  if (valid.length) {
    const max = Math.max(...valid.map((x) => x.t));
    latest = valid.filter((x) => x.t === max).map((x) => x.o);
  } else {
    latest = [...r.observations];
    warnings.push("Observation time invalid — freshness unknown");
  }
  // Deterministic tie policy: canonical JSON order; disagreement is uncertainty.
  latest.sort((a, b) => sig(a).localeCompare(sig(b)));
  const o = latest[0]!;
  const differs = (f: (x: RawMaterialObservation) => unknown) => new Set(latest.map((x) => JSON.stringify(f(x)))).size > 1;
  if (differs((x) => x.title) || differs((x) => x.fileType) || differs((x) => x.section) || differs((x) => x.kind) || differs((x) => x.destinationUrl)) warnings.push("Latest observations disagree — metadata uncertain");
  const label = o.title.kind === "known" ? safeLabel(o.title.value) : null;
  const sectionLabel = o.section.kind === "known" ? safeLabel(o.section.value) : null;
  const title = label ?? `Untitled ${o.kind === "folder" ? "folder" : o.kind} (title not collected)`;
  const listingSrc = [o, ...o.references].find((x) => x.listingScope || x.listingCoverage);
  return {
    key: `collected:${r.id}`, recordId: r.id, provenance: "collected", courseId: r.courseId, sourceCourseId: o.sourceCourseId,
    resourceKey: o.resourceKey, ...(o.parentResourceKey ? { parentResourceKey: o.parentResourceKey } : {}),
    kind: o.kind, title, titleKnown: !!label, section: sectionLabel, type: typeOf(o),
    mimeType: o.mimeType.kind === "known" && o.kind !== "folder" ? o.mimeType.value : null,
    source: sourceLink(o), destination: destinationLink(o),
    ...(o.kind === "folder" ? { listing: { ...(listingSrc?.listingScope ? { scope: listingSrc.listingScope } : {}), ...(listingSrc?.listingCoverage ? { coverage: listingSrc.listingCoverage } : {}) } } : {}),
    lastObservedAt: valid.length ? new Date(Math.max(...valid.map((x) => x.t))).toISOString() : null,
    access: "not_verified", stale: false, warnings, breadcrumb: [], parentUnavailable: false, children: [],
  };
}

function fromLegacy(m: Material): LibraryItem {
  const source = safeSourceHref(m.url);
  let destination: LibraryLink | null = null;
  if (!source && m.fileType === "link") {
    const d = safeDestination(m.url, "url");
    destination = d.url === m.url && !m.url.startsWith(`${SDU_ORIGIN}/`) ? { href: m.url, external: true } : { href: null, external: false, reason: "Destination link failed the safety check" };
  }
  const label = safeLabel(m.title);
  return {
    key: `legacy:${m.id}`, recordId: m.id, provenance: "legacy", courseId: m.courseId, kind: m.fileType === "link" ? "link" : "file",
    title: label ?? "Untitled material (title unavailable)", titleKnown: !!label, section: safeLabel(m.section), type: m.fileType, mimeType: null,
    source: source ? { href: source, external: false } : destination ? { href: null, external: false } : { href: null, external: false, reason: "Source link failed the safety check" },
    destination, lastObservedAt: time(m.lastCheckedAt) === null ? null : m.lastCheckedAt,
    access: m.accessible ? "legacy_accessible" : "legacy_inaccessible", stale: m.stale, ...(m.downloadedAt ? { downloadedAt: m.downloadedAt } : {}),
    warnings: time(m.lastCheckedAt) === null ? ["Last check time invalid — freshness unknown"] : [], breadcrumb: [], parentUnavailable: false, children: [],
  };
}

/** Latest material refresh attempt per source course (receipt facts only). */
export function latestMaterialAttempts(snap: Snapshot): Map<string, PageRefreshReceipt> {
  const out = new Map<string, PageRefreshReceipt>();
  for (const r of snap.collection?.refreshes ?? []) {
    if (r.collector !== "material") continue;
    const t = time(r.observedAt);
    if (t === null) continue;
    for (const id of r.sourceCourseIds) {
      const prior = out.get(id);
      if (!prior || (time(prior.observedAt) ?? 0) < t) out.set(id, r);
    }
  }
  return out;
}
export const attemptReasons = (r: PageRefreshReceipt) => [...new Set(r.reasons.filter((x) => SAFE_REASONS.has(x)))];

/** Build the library for tracked courses only. Unmapped course IDs are never attached by title. */
export function buildMaterialLibrary(snap: Snapshot): LibraryItem[] {
  const tracked = new Set(snap.settings.trackedCourseIds.filter((id) => snap.courses.some((c) => c.id === id)));
  const records = (snap.collection?.records ?? []).filter((r): r is NormalizedMaterialRecord => r.kind === "material");
  const seen = new Set<string>();
  const items: LibraryItem[] = [];
  for (const r of records) {
    if (seen.has(r.id) || !tracked.has(r.courseId)) continue;
    seen.add(r.id);
    items.push(fromRecord(r));
  }
  for (const m of snap.materials) if (!seen.has(m.id) && tracked.has(m.courseId)) { seen.add(m.id); items.push(fromLegacy(m)); }

  // Folder relations: exact (course, source course, resourceKey) binding only.
  const scope = (i: LibraryItem, key: string) => `${i.courseId}\u0000${i.sourceCourseId ?? ""}\u0000${key}`;
  const byKey = new Map<string, LibraryItem[]>();
  for (const i of items) if (i.provenance === "collected" && i.resourceKey) byKey.set(scope(i, i.resourceKey), [...(byKey.get(scope(i, i.resourceKey)) ?? []), i]);
  const parentOf = (i: LibraryItem) => {
    if (!i.parentResourceKey) return undefined;
    const c = byKey.get(scope(i, i.parentResourceKey));
    return c?.length === 1 && c[0]!.kind === "folder" ? c[0] : undefined;
  };
  for (const i of items) {
    if (!i.parentResourceKey) continue;
    const chain: string[] = [];
    const visited = new Set<LibraryItem>([i]);
    let p = parentOf(i);
    let ok = true;
    for (let depth = 0; ; depth++) {
      if (!p || visited.has(p) || depth > 16) { ok = false; break; }
      visited.add(p);
      chain.unshift(p.title);
      if (!p.parentResourceKey) break;
      p = parentOf(p);
    }
    if (ok) { i.breadcrumb = chain; parentOf(i)!.children.push(i.key); }
    else { i.parentUnavailable = true; i.warnings.push("Parent folder unavailable — it was not collected or its identity is ambiguous"); }
  }
  return items;
}

export interface LibraryFilter { q: string; type: "" | LibraryType }
export function filterLibrary(items: LibraryItem[], f: LibraryFilter): LibraryItem[] {
  const needle = normalizeSearch(f.q);
  return items.filter((i) => (!f.type || i.type === f.type) && (!needle || (i.titleKnown && normalizeSearch(i.title).includes(needle))));
}
