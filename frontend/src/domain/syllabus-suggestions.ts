import { safeDestination, unsafeLabel } from "../../../extension/src/moodle-materials";
import type { Snapshot, NormalizedMaterialRecord } from "./types";

// Title evidence is Unicode-normalized and case-insensitive. The score is title
// evidence (100), supported type (20), then normalized title and stable ID.
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
export function rankSyllabusSuggestions(snapshot: Snapshot) {
  const records = (snapshot.collection?.records ?? []).filter((r): r is NormalizedMaterialRecord => r.kind === "material");
  const seen = new Set<string>();
  return records.flatMap((r) => {
    if (seen.has(r.id)) return [];
    seen.add(r.id);
    const obs = r.observations.filter((o) => o.kind !== "folder");
    if (!obs.length) return [];
    const latest = [...obs].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const titles = [...new Set(obs.map((o) => o.title.kind === "known" ? normalize(o.title.value) : ""))];
    const types = [...new Set(obs.map((o) => o.fileType.kind === "known" ? o.fileType.value : "unknown"))];
    const rawTitle = latest[0]!.title.kind === "known" ? latest[0]!.title.value.trim() : "";
    const title = rawTitle && !/[<>\u0000-\u001f]/u.test(rawTitle) && !unsafeLabel(rawTitle) && !/(?:token|sesskey|password|authorization)\s*[=:]/iu.test(rawTitle) ? rawTitle : "Unknown title";
    const normalized = normalize(title);
    const matches = /(?:\bsyllabus\b|силлабус|рабочая программа дисциплины)/u.test(normalized);
    let uncertain = titles.length !== 1 || types.length !== 1 || titles[0] === "" || types[0] === "unknown" || !matches || title === "Unknown title" || obs.length !== r.observations.length;
    const type = types.length === 1 ? types[0] : "conflicting types";
    const destinations = [...new Set(obs.flatMap((o) => [o.destinationUrl, ...o.references.map((ref) => ref.destinationUrl)].flatMap((value) => {
      if (!value) return [];
      const result = safeDestination(value, o.sourceModuleType, !!o.parentResourceKey);
      return result.url === value && (!result.contextId || result.contextId === o.sourceContextId) ? [value] : [];
    })))].sort();
    const sourceLinks = [...new Set(obs.flatMap((o) => o.parentResourceKey ? [] : [o.sourceUrl, ...o.references.map((ref) => ref.sourceUrl)].filter((value) => value === `https://moodle.sdu.edu.kz/mod/${o.sourceModuleType}/view.php?id=${o.sourceCourseModuleId}`)))].sort();
    uncertain ||= destinations.length > 1 || sourceLinks.length > 1;
    const link = destinations.length === 1 ? destinations[0] : destinations.length === 0 && sourceLinks.length === 1 ? sourceLinks[0] : undefined;
    const score = (matches ? 100 : 0) + (["pdf", "docx"].includes(type!) ? 20 : 0);
    return [{ id: r.id, courseId: r.courseId, title, type, link, uncertain, score, reason: matches ? "Title mentions a syllabus or course programme" : "Title does not clearly identify a syllabus" }];
  }).sort((a, b) => b.score - a.score || normalize(a.title).localeCompare(normalize(b.title), "ru") || a.id.localeCompare(b.id));
}
