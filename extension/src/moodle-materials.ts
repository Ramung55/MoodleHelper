/**
 * #17 pure synthetic DOM collector; NOT observed SDU compatibility (#3/#4).
 * Exact structural and privacy vocabulary: _docs/material-collection-contract.md.
 * IDs stay positive decimal strings; keys are origin/course/module/file tuples,
 * never names/revisions/times. Metadata is known or unknown, never guessed from
 * filenames. Duplicate conflicts are sticky unknown; unsafe parent associations
 * and descendants are excluded. Output is raw evidence, NOT Material/Snapshot.
 * Complete means supplied_pages_only, never all resources in a live course.
 * All DOM access is read-only; no network, navigation, logging, storage or runtime.
 */
import { detectMoodleAccess, type MoodleAccessInput, type MoodleAccessResult } from "./moodle-access";
import { exact } from "./moodle-dates";

export type Metadata<T> = { kind: "known"; value: T } | { kind: "unknown" };
export type MaterialKind = "file" | "link" | "folder";
export type ModuleType = "resource" | "url" | "folder";
export type MaterialFileType = "pdf" | "docx" | "pptx" | "link" | "video" | "other";
export type MaterialCoverage = "complete" | "partial" | "none";
export type MaterialReason = "access_error" | "invalid_selection" | "invalid_observed_at" |
  "unsupported_structure" | "identity_mismatch" | "missing_identity" | "unselected_course" |
  "malformed_candidate" | "unsafe_url" | "unsafe_external_url" | "missing_metadata" |
  "type_conflict" | "invalid_mime" | "unsafe_label" | "field_conflict" | "parent_conflict" | "pagination_pending" |
  "incomplete_list" | "empty_unconfirmed" | "empty_conflict" | "folder_contents_uninspected";
export interface MaterialReference {
  sourcePageUrl: string;
  sourceUrl: string;
  destinationUrl?: string;
  observedAt: string;
  location: "course.material" | "activity.material" | "folder.entry";
  listingScope?: "reference_only" | "supplied_listing_only";
  listingCoverage?: MaterialCoverage;
}
export interface RawMaterialObservation extends MaterialReference {
  sourceCourseId: string;
  sourceCourseModuleId: string;
  sourceModuleType: ModuleType;
  sourceResourceId?: string;
  sourceFileId?: string;
  sourceFolderId?: string;
  sourceContextId?: string;
  resourceKey: string;
  parentResourceKey?: string;
  kind: MaterialKind;
  title: Metadata<string>;
  section: Metadata<string>;
  fileType: Metadata<MaterialFileType>;
  mimeType: Metadata<string>;
  references: MaterialReference[];
}
export interface MaterialDiagnostic { pageIndex: number; recordIndex?: number; reason: MaterialReason }
export interface MaterialReview extends MaterialDiagnostic { candidate?: RawMaterialObservation }
export interface MaterialPage {
  pageIndex: number;
  access: MoodleAccessResult;
  candidateCount: number;
  coverage: MaterialCoverage;
  paginationPending: boolean;
}
export interface MaterialCollection {
  observations: RawMaterialObservation[];
  review: MaterialReview[];
  exclusions: MaterialDiagnostic[];
  diagnostics: MaterialDiagnostic[];
  pages: MaterialPage[];
  coverage: MaterialCoverage;
  scope: "supplied_pages_only";
}
const origin = "https://moodle.sdu.edu.kz";
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const unknown = (): { kind: "unknown" } => ({ kind: "unknown" });
const known = <T>(value: T): Metadata<T> => ({ kind: "known", value });
const normalizedText = (node?: Element | null): string => (node?.textContent ?? "").replace(/\s+/gu, " ").trim();
// PM 275c369: URL-shaped labels cannot leak rejected hrefs through metadata.
// Ordinary prose receives no speculative secret filtering.
const unsafeLabel = (value: string): boolean => /[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ||
  /(?:^|\s)(?:javascript:|data:|file:|mailto:|\/\/|\/course\/|\/mod\/|\/pluginfile\.php\/)/i.test(value);
const label = (node?: Element | null): Metadata<string> => {
  const value = normalizedText(node);
  return value && !unsafeLabel(value) ? known(value) : unknown();
};
const modules = new Set(["resource", "url", "folder"]);
const types = new Set(["pdf", "docx", "pptx", "link", "video", "other"]);
const key = (...parts: string[]): string => JSON.stringify([origin, ...parts]);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const direct = (node: Element, selector: string): Element[] => Array.from(node.children).filter(child => child.matches(selector));
const mimeType = (mime: string): MaterialFileType => {
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  return mime.startsWith("video/") ? "video" : "other";
};

// Frozen privacy vocabulary, before implementation (PM b8e4959/45351f9):
// canonical once-decoded filename segments; sensitive separator-delimited words;
// JWT-like three dotted parts; >=32-character opaque runs. f78955f allows
// canonical UTF-8 filenames and exempts exact PDF/Office MIME literals.
const privatePart = (value: string): boolean =>
  /(?:^|[._~-])(?:token|access|sesskey|auth|authorization|key|api|signature|secret|password|credential|bearer)(?:$|[._~-])/i.test(value) ||
  /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value) || /[A-Za-z0-9_-]{32}/.test(value);
const literalValue = (value: string): boolean => /^[A-Za-z0-9._~-]+$/.test(value) && !privatePart(value);
const trustedMime = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const safeMime = (value: string): boolean => trustedMime.has(value) || (value.length <= 127 &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value) && value.split("/").every(part => !privatePart(part)));
function filenameSegment(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded === "." || decoded === ".." || !/^[\p{L}\p{M}\p{N} ._~!$&'()+,;=@-]+$/u.test(decoded) || encodeURIComponent(decoded) !== value || privatePart(decoded)) return false;
    return !/(?:^|[ ._~!$&'()+,;=@-])(?:token|access|sesskey|auth|authorization|key|api|signature|secret|password|credential|bearer)(?:$|[ ._~!$&'()+,;=@-])/i.test(decoded);
  } catch { return false; }
}
function moodleHref(value: string | null, absoluteOnly = false): string | null {
  if (!value || /[\s\\\x00-\x1f\x7f#]/u.test(value)) return null;
  if (value.startsWith(origin + "/")) return value;
  if (!absoluteOnly && /^\/(?!\/)/.test(value)) return origin + value;
  return null;
}
interface Route { href: string; type: "course" | ModuleType; id: string }
function canonicalRoute(value: string | null, absoluteOnly = false): Route | null {
  const href = moodleHref(value, absoluteOnly);
  if (!href) return null;
  const match = /^https:\/\/moodle\.sdu\.edu\.kz\/(course|mod\/(resource|url|folder))\/view\.php\?id=([1-9][0-9]*)$/.exec(href);
  return match ? { href, type: match[1]! === "course" ? "course" : match[2]! as ModuleType, id: match[3]! } : null;
}
interface SafeDestination { url?: string; contextId?: string; reason?: "unsafe_url" | "unsafe_external_url" }
function safeFolder(value: string | null, moduleId: string, folderId: string): SafeDestination {
  const href = moodleHref(value);
  return href === `${origin}/mod/folder/view.php?id=${moduleId}&folder=${folderId}` ? { url: href } : { reason: "unsafe_url" };
}
function safeDestination(value: string | null, moduleType: ModuleType, pluginOnly = false): SafeDestination {
  const href = moodleHref(value);
  if (href) {
    const match = /^https:\/\/moodle\.sdu\.edu\.kz\/pluginfile\.php\/([1-9][0-9]*)\/mod_(resource|folder)\/content\/([1-9][0-9]*)\/([^?]+)(\?forcedownload=1)?$/.exec(href);
    if (match && match[2]! === moduleType && match[4]!.split("/").every(filenameSegment)) return { url: href, contextId: match[1]! };
    if (!pluginOnly) {
      const route = canonicalRoute(href);
      if (route) return { url: route.href };
    }
    return { reason: "unsafe_url" };
  }
  if (pluginOnly || !value || value.startsWith("/") || /^https:\/\/[^/]*moodle\.sdu\.edu\.kz/i.test(value)) return { reason: "unsafe_url" };
  // Exact serialization; canonical UTF-8 escapes only within filename paths.
  // No ports, credentials, aliases or normalization into a working URL.
  if (/[\s\\\x00-\x1f\x7f]/u.test(value)) return { reason: "unsafe_external_url" };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.href !== value || url.username || url.password ||
      !/^https:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?:\/)/.test(value) || url.port ||
      (!url.hostname.startsWith("[") && (url.hostname.length > 253 || !url.hostname.split(".").every(part => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))))) return { reason: "unsafe_external_url" };
    const path = url.pathname;
    if (path !== "/" && (!path.startsWith("/") || !path.slice(1).replace(/\/$/, "").split("/").every(filenameSegment))) return { reason: "unsafe_external_url" };
    const hashAt = value.indexOf("#");
    if (hashAt !== -1 && !literalValue(value.slice(hashAt + 1))) return { reason: "unsafe_external_url" };
    const queryAt = value.indexOf("?");
    if (queryAt !== -1 && (hashAt === -1 || queryAt < hashAt)) {
      const query = value.slice(queryAt + 1, hashAt === -1 ? undefined : hashAt);
      const seen = new Set<string>();
      for (const token of query.split("&")) {
        const pair = /^(id|page|lang|v)=([A-Za-z0-9._~-]+)$/.exec(token);
        if (!pair || seen.has(pair[1]!) || privatePart(pair[2]!)) return { reason: "unsafe_external_url" };
        seen.add(pair[1]!);
      }
    }
    return { url: value };
  } catch { return { reason: "unsafe_external_url" }; }
}

/** Batch arguments never bypass the real #10 per-page access detector. */
export function collectMoodleMaterials(
  inputs: readonly MoodleAccessInput[], selectedSourceCourseIds: readonly string[], observedAt: string,
): MaterialCollection {
  const result: MaterialCollection = { observations: [], review: [], exclusions: [], diagnostics: [], pages: [], coverage: "none", scope: "supplied_pages_only" };
  const selected = Array.isArray(selectedSourceCourseIds) && selectedSourceCourseIds.every(id) ? new Set(selectedSourceCourseIds) : null;
  const validTime = typeof observedAt === "string" && exact(observedAt);
  const byKey = new Map<string, RawMaterialObservation>();
  const invalidKeys = new Set<string>();
  const conflicts = new Map<string, Set<string>>();
  if (!Array.isArray(inputs as unknown)) return result;
  inputs.forEach((input, pageIndex) => {
    const page: MaterialPage = { pageIndex, access: detectMoodleAccess(input), candidateCount: 0, coverage: "none", paginationPending: false };
    result.pages.push(page);
    let damaged = false;
    let flush = () => {};
    const report = (reason: MaterialReason, recordIndex?: number, candidate?: RawMaterialObservation, exclude = false) => {
      damaged = true;
      const diagnostic: MaterialDiagnostic = { pageIndex, ...(recordIndex === undefined ? {} : { recordIndex }), reason };
      result.diagnostics.push(diagnostic);
      if (exclude) result.exclusions.push({ ...diagnostic });
      else result.review.push({ ...diagnostic, ...(candidate ? { candidate: clone(candidate) } : {}) });
    };
    const readLabel = (node?: Element | null, recordIndex?: number): Metadata<string> => {
      if (unsafeLabel(normalizedText(node))) report("unsafe_label", recordIndex);
      return label(node);
    };
    if (page.access.status !== "accessible") { report("access_error", undefined, undefined, true); return; }
    if (!selected) { report("invalid_selection", undefined, undefined, true); return; }
    if (!validTime) { report("invalid_observed_at", undefined, undefined, true); return; }
    try {
      const route = canonicalRoute(input.finalUrl, true);
      const requested = canonicalRoute(input.requestedUrl, true);
      if (!route || !requested || route.href !== requested.href) { report("unsafe_url", undefined, undefined, true); return; }
      const coursePage = route.type === "course";
      const mains = input.document.querySelectorAll(`main[data-region="${coursePage ? "course-content" : "activity"}"]`);
      if (mains.length !== 1) { report("unsupported_structure", undefined, undefined, true); return; }
      const main = mains[0]!;
      const headings = main.querySelectorAll("h1");
      const courseLinks = main.querySelectorAll('a[data-role="course-link"]');
      if (headings.length !== 1 || !normalizedText(headings[0]!) || courseLinks.length !== 1) { report("unsupported_structure", undefined, undefined, true); return; }
      const course = canonicalRoute(courseLinks[0]!.getAttribute("href"));
      if (!course || course.type !== "course" || (coursePage && route.id !== course.id)) { report("identity_mismatch", undefined, undefined, true); return; }
      if (!selected.has(course.id)) { report("unselected_course", undefined, undefined, true); return; }
      page.coverage = "partial";
      const pagination = Array.from(main.querySelectorAll('nav[data-region="material-pagination"]')).filter(node => node.querySelector('a[href], button, [rel="next"]'));
      const incomplete = [...(main.matches("[data-incomplete], [data-truncated]") ? [main] : []), ...main.querySelectorAll("[data-incomplete], [data-truncated]")];
      page.paginationPending = pagination.length > 0;
      for (const node of pagination) if (coursePage || !node.closest("ul")) report("pagination_pending");
      for (const node of incomplete) if (coursePage || !node.closest("ul")) report("incomplete_list");
      const pending: { candidate: RawMaterialObservation; recordIndex: number; reasons: MaterialReason[] }[] = [];
      const add = (candidate: RawMaterialObservation, recordIndex: number, reasons: MaterialReason[]) => {
        reasons.forEach(reason => report(reason, recordIndex, candidate));
        const prior = byKey.get(candidate.resourceKey);
        if (invalidKeys.has(candidate.resourceKey)) { report("parent_conflict", recordIndex, undefined, true); return; }
        if (!prior) { byKey.set(candidate.resourceKey, candidate); return; }
        if (prior.parentResourceKey !== candidate.parentResourceKey ||
          (prior.sourceResourceId && candidate.sourceResourceId && prior.sourceResourceId !== candidate.sourceResourceId)) {
          invalidKeys.add(candidate.resourceKey);
          report("parent_conflict", recordIndex, undefined, true); return;
        }
        if (!prior.sourceResourceId && candidate.sourceResourceId) prior.sourceResourceId = candidate.sourceResourceId;
        const blocked = conflicts.get(candidate.resourceKey) ?? new Set<string>();
        conflicts.set(candidate.resourceKey, blocked);
        for (const field of ["title", "section", "fileType", "mimeType"] as const) {
          const a = prior[field], b = candidate[field];
          if (blocked.has(field)) continue;
          if (a.kind === "unknown" && b.kind === "known") Object.assign(prior, { [field]: clone(b) });
          else if (a.kind === "known" && b.kind === "known" && a.value !== b.value) {
            blocked.add(field); Object.assign(prior, { [field]: unknown() }); report("field_conflict", recordIndex, prior);
          }
        }
        if (reasons.includes("type_conflict")) { blocked.add("fileType"); prior.fileType = unknown(); }
        if (!prior.destinationUrl && candidate.destinationUrl && !blocked.has("destinationUrl")) prior.destinationUrl = candidate.destinationUrl;
        else if (prior.destinationUrl && candidate.destinationUrl && prior.destinationUrl !== candidate.destinationUrl) {
          delete prior.destinationUrl; blocked.add("destinationUrl"); report("field_conflict", recordIndex, prior);
        }
        if (prior.sourceContextId !== candidate.sourceContextId) delete prior.sourceContextId;
        // Keep contributor proof objects until listing coverage is finalized;
        // public output is detached and identical references deduplicate below.
        prior.references.push(...candidate.references);
      };
      flush = () => { pending.splice(0).forEach(item => add(item.candidate, item.recordIndex, item.reasons)); };
      const stage = (candidate: RawMaterialObservation, recordIndex: number, reasons: MaterialReason[]) => { pending.push({ candidate, recordIndex, reasons }); };
      const metadata = (node: Element, title: Metadata<string>, section: Metadata<string>, destination: Element | undefined, isLink: boolean, isFolder = false) => {
        const reasons: MaterialReason[] = [];
        const explicit = node.getAttribute("data-file-type") ?? "";
        let fileType: Metadata<MaterialFileType> = types.has(explicit) ? known(explicit as MaterialFileType) : unknown();
        const rawMime = destination?.getAttribute("type");
        let mime: Metadata<string> = unknown();
        if (rawMime && safeMime(rawMime)) mime = known(rawMime.toLowerCase());
        else if (rawMime !== null && rawMime !== undefined) reasons.push("invalid_mime");
        const evidence = [fileType.kind === "known" ? fileType.value : null, mime.kind === "known" ? mimeType(mime.value) : null, isLink ? "link" : null].filter(Boolean);
        if (new Set(evidence).size > 1) { fileType = unknown(); reasons.push("type_conflict"); }
        else if (evidence.length) fileType = known(evidence[0]! as MaterialFileType);
        if ([title, section, ...(isFolder ? [] : [fileType, mime])].some(value => value.kind === "unknown") || (!isFolder && !destination)) reasons.push("missing_metadata");
        return { title, section, fileType, mimeType: mime, reasons };
      };
      const parseRoot = (node: Element, section: Metadata<string>, recordIndex: number): RawMaterialObservation | undefined => {
        const moduleType = node.getAttribute("data-module-type");
        const moduleId = node.getAttribute("data-course-module-id");
        const instance = node.getAttribute("data-resource-id");
        if (!id(moduleId) || !moduleType || !modules.has(moduleType) || (instance !== null && !id(instance))) { report("missing_identity", recordIndex, undefined, true); return; }
        const sourceUrl = `${origin}/mod/${moduleType}/view.php?id=${moduleId}`;
        const links = coursePage ? node.querySelectorAll('a[data-role="material-link"]') : [];
        if ((coursePage && links.length !== 1) || (!coursePage && sourceUrl !== route.href)) { report("identity_mismatch", recordIndex, undefined, true); return; }
        if (coursePage && canonicalRoute(links[0]!.getAttribute("href"))?.href !== sourceUrl) { report("unsafe_url", recordIndex, undefined, true); return; }
        const destinations = node.querySelectorAll('a[data-role="destination"]');
        if (destinations.length > 1) { report("malformed_candidate", recordIndex, undefined, true); return; }
        const destination = destinations[0]!;
        const safe = destination ? safeDestination(destination.getAttribute("href"), moduleType as ModuleType) : undefined;
        const title = coursePage ? readLabel(links[0]!, recordIndex) : readLabel(headings[0]!, recordIndex);
        const facts = metadata(node, title, section, destination, moduleType === "url", moduleType === "folder");
        const reference: MaterialReference = { sourcePageUrl: route.href, sourceUrl, observedAt, location: coursePage ? "course.material" : "activity.material", ...(safe?.url ? { destinationUrl: safe.url } : {}), ...(moduleType === "folder" ? { listingScope: "reference_only", listingCoverage: "none" } : {}) };
        const candidate: RawMaterialObservation = { ...reference, sourceCourseId: course.id, sourceCourseModuleId: moduleId, sourceModuleType: moduleType as ModuleType, ...(instance ? { sourceResourceId: instance } : {}), ...(safe?.contextId ? { sourceContextId: safe.contextId } : {}), resourceKey: key(course.id, moduleType, "module", moduleId), kind: moduleType === "url" ? "link" : moduleType === "folder" ? "folder" : "file", title: facts.title, section: facts.section, fileType: facts.fileType, mimeType: facts.mimeType, references: [{ ...reference }] };
        if (safe?.reason) facts.reasons.push(safe.reason);
        // A conflict within the first observation also stays unknown on repeats.
        if (facts.reasons.includes("type_conflict")) {
          const blocked = conflicts.get(candidate.resourceKey) ?? new Set<string>(); blocked.add("fileType"); conflicts.set(candidate.resourceKey, blocked);
        }
        stage(candidate, recordIndex, facts.reasons);
        return candidate;
      };
      if (coursePage) {
        const nodes = Array.from(main.querySelectorAll('article[data-region="material"]'));
        page.candidateCount = nodes.length;
        const sections = main.querySelectorAll('section[data-region="course-section"]');
        for (const section of sections) if (section.querySelectorAll("h2").length > 1 || section.parentElement?.closest('section[data-region="course-section"]')) report("unsupported_structure");
        nodes.forEach((node, index) => {
          const section = node.parentElement;
          if (!section?.matches('section[data-region="course-section"]') || section.querySelectorAll("h2").length > 1 || section.parentElement?.closest('section[data-region="course-section"]') || node.querySelector('article[data-region="material"]')) { report("malformed_candidate", index, undefined, true); return; }
          parseRoot(node, readLabel(section.querySelector("h2"), index), index);
        });
        const empties = main.querySelectorAll('[data-role="materials-empty"]');
        if (!nodes.length && empties.length !== 1) report("empty_unconfirmed");
        if (nodes.length && empties.length) report("empty_conflict");
      } else {
        page.candidateCount = 1;
        const sections = main.querySelectorAll('[data-role="material-section"]');
        if (sections.length > 1) { report("malformed_candidate", 0, undefined, true); return; }
        const root = parseRoot(main, readLabel(sections[0]!, 0), 0);
        if (!root) return;
        if (root.kind === "folder") {
          const lists = main.querySelectorAll('ul[data-region="folder-contents"]');
          if (lists.length !== 1) { report("unsupported_structure", undefined, undefined, true); flush(); return; }
          const list = lists[0]!;
          const entries = Array.from(list.querySelectorAll('li[data-region="folder-entry"]'));
          page.candidateCount += entries.length;
          const local = new Map<Element, RawMaterialObservation>();
          const entryIndices = new Map(entries.map((node, offset) => [node, offset + 1]));
          const parents = new Map<number, number>();
          const inspected = new Map<number, { candidate: RawMaterialObservation; list: Element }>([[0, { candidate: root, list }]]);
          entries.forEach((node, offset) => {
            const index = offset + 1;
            const kind = node.getAttribute("data-entry-kind");
            const entryId = node.getAttribute(kind === "folder" ? "data-folder-id" : "data-file-id");
            const parentNode = node.parentElement?.closest('li[data-region="folder-entry"]');
            parents.set(index, parentNode ? entryIndices.get(parentNode) ?? 0 : 0);
            const parent = parentNode ? local.get(parentNode) : root;
            const anchors = direct(node, 'a[data-role="entry-link"]');
            const sublists = direct(node, "ul");
            if (!parent || parent.kind !== "folder" || !node.parentElement?.matches("ul") || (parentNode ? node.parentElement.parentElement !== parentNode : node.parentElement !== list) || anchors.length !== 1 || sublists.length > 1 || (kind !== "file" && kind !== "folder") || (kind === "file" && sublists.length)) { report("malformed_candidate", index, undefined, true); return; }
            if (!id(entryId)) { report("missing_identity", index, undefined, true); return; }
            const entryKey = key(course.id, "folder", root.sourceCourseModuleId, kind, entryId);
            let ancestorNode = parentNode;
            while (ancestorNode) {
              if (local.get(ancestorNode)?.resourceKey === entryKey) { invalidKeys.add(entryKey); report("parent_conflict", index, undefined, true); return; }
              ancestorNode = ancestorNode.parentElement?.closest('li[data-region="folder-entry"]');
            }
            const safe = kind === "folder" ? safeFolder(anchors[0]!.getAttribute("href"), root.sourceCourseModuleId, entryId) : safeDestination(anchors[0]!.getAttribute("href"), "folder", true);
            if (!safe.url) { report(safe.reason ?? "unsafe_url", index, undefined, true); return; }
            const facts = metadata(node, readLabel(anchors[0]!, index), root.section, anchors[0]!, false, kind === "folder");
            const reference: MaterialReference = { sourcePageUrl: route.href, sourceUrl: root.sourceUrl, destinationUrl: safe.url, observedAt, location: "folder.entry", ...(kind === "folder" ? { listingScope: "reference_only", listingCoverage: "none" } : {}) };
            const child: RawMaterialObservation = { ...reference, sourceCourseId: course.id, sourceCourseModuleId: root.sourceCourseModuleId, sourceModuleType: "folder", ...(root.sourceResourceId ? { sourceResourceId: root.sourceResourceId } : {}), ...(kind === "file" ? { sourceFileId: entryId } : { sourceFolderId: entryId }), ...(safe.contextId ? { sourceContextId: safe.contextId } : {}), resourceKey: entryKey, parentResourceKey: parent.resourceKey, kind, title: facts.title, section: facts.section, fileType: facts.fileType, mimeType: facts.mimeType, references: [{ ...reference }] };
            if (facts.reasons.includes("type_conflict")) {
              const blocked = conflicts.get(entryKey) ?? new Set<string>(); blocked.add("fileType"); conflicts.set(entryKey, blocked);
            }
            stage(child, index, facts.reasons); local.set(node, child);
            if (kind === "folder") {
              if (sublists.length) inspected.set(index, { candidate: child, list: sublists[0]! });
              else report("folder_contents_uninspected", index);
            }
          });
          const listIndices = new Map([...inspected].map(([index, item]) => [item.list, index]));
          const ownerIndex = (node: Element): number => listIndices.get(node.closest("ul")!) ?? entryIndices.get(node.closest('li[data-region="folder-entry"]')!) ?? 0;
          for (const nestedList of list.querySelectorAll("ul")) {
            if (!nestedList.parentElement?.matches('li[data-region="folder-entry"][data-entry-kind="folder"]')) report("malformed_candidate", ownerIndex(nestedList));
          }
          for (const node of pagination) if (node.closest("ul")) report("pagination_pending", ownerIndex(node));
          for (const node of incomplete) if (node.closest("ul")) report("incomplete_list", ownerIndex(node));
          for (const [index, item] of inspected) {
            const empties = Array.from(item.list.querySelectorAll('[data-role="folder-empty"]')).filter(node => node.closest("ul") === item.list);
            const children = entries.filter(node => node.parentElement === item.list);
            if (!children.length && empties.length !== 1) report("empty_unconfirmed", index);
            if (children.length && empties.length) report("empty_conflict", index);
          }
          const affects = (issueIndex: number | undefined, folderIndex: number): boolean => {
            if (issueIndex === undefined) return true;
            let index: number | undefined = issueIndex;
            while (index !== undefined) { if (index === folderIndex) return true; index = parents.get(index); }
            return false;
          };
          const finalizeListings = () => {
            const issues = result.diagnostics.filter(item => item.pageIndex === pageIndex);
            for (const [index, item] of inspected) {
              const hasIssue = issues.some(issue => affects(issue.recordIndex, index)) || pending.some(record => record.reasons.length > 0 && affects(record.recordIndex, index));
              item.candidate.listingScope = "supplied_listing_only";
              item.candidate.listingCoverage = hasIssue ? "partial" : "complete";
              // First contributor reference belongs to this supplied candidate.
              Object.assign(item.candidate.references[0]!, { listingScope: item.candidate.listingScope, listingCoverage: item.candidate.listingCoverage });
            }
          };
          finalizeListings();
          flush();
          // Duplicate fact/identity conflicts are discovered by the merge above;
          // they also affect this inspected contributor and its ancestors.
          finalizeListings();
        }
      }
      flush();
      page.coverage = damaged ? "partial" : "complete";
    } catch { report("unsupported_structure", undefined, undefined, true); flush(); }
  });
  // Invalid parent associations invalidate the entire branch, even when the
  // conflicting duplicate appeared after its children or on another page.
  let changed = true;
  while (changed) {
    changed = false;
    for (const value of byKey.values()) if (value.parentResourceKey && invalidKeys.has(value.parentResourceKey) && !invalidKeys.has(value.resourceKey)) { invalidKeys.add(value.resourceKey); changed = true; }
  }
  for (const value of byKey.values()) {
    value.references = value.references.filter((reference, index, references) => references.findIndex(other => JSON.stringify(other) === JSON.stringify(reference)) === index);
    if (value.kind === "folder") {
      const inspected = value.references.filter(reference => reference.listingScope === "supplied_listing_only");
      value.listingScope = inspected.length ? "supplied_listing_only" : "reference_only";
      value.listingCoverage = inspected.length ? inspected.some(reference => reference.listingCoverage !== "complete") ? "partial" : "complete" : "none";
    }
  }
  result.observations = [...byKey.values()].filter(value => !invalidKeys.has(value.resourceKey)).map(clone);
  // Review records cannot retain associations rejected later in the batch.
  result.review = result.review.map(item => item.candidate && invalidKeys.has(item.candidate.resourceKey) ? { pageIndex: item.pageIndex, ...(item.recordIndex === undefined ? {} : { recordIndex: item.recordIndex }), reason: item.reason } : item);
  for (const item of result.review) if (item.candidate?.kind === "folder") {
    const merged = byKey.get(item.candidate.resourceKey);
    if (merged) Object.assign(item.candidate, { listingScope: merged.listingScope, listingCoverage: merged.listingCoverage, references: clone(merged.references) });
  }
  result.coverage = result.pages.length && result.pages.every(page => page.coverage === "complete") ? "complete" : result.pages.some(page => page.coverage !== "none") ? "partial" : "none";
  return result;
}
