import type { AssessmentMention } from "./assessment-mentions";
import type { DateValue } from "./types";
import { calendarDate, zonedInstants } from "./personal-event";

export type SyllabusDateContext = {
  dateOrder?: string; conflictingDateOrder?: boolean;
  timezone?: { zone: string; source: "document" | "course" };
  semester?: { start: string; end: string };
};
export type SyllabusDateProposal = {
  id: string; parentId: string; expression: string; start: number; end: number; label?: string;
  date: DateValue; status: "unconfirmed"; state: "proposed" | "unresolved" | "invalid"; reasons: string[];
  wallTime?: { date: string; time: string }; yearInferredFrom?: { start: string; end: string };
  zoneProvenance?: { kind: "offset" | "written_iana" | "document" | "course"; value: string };
};
export type ParsedAssessmentMention = { mention: AssessmentMention; dates: SyllabusDateProposal[] };

const MONTHS: Record<string, number> = {};
[
  ["january", "jan", "январь", "января", "янв"], ["february", "feb", "февраль", "февраля", "фев"],
  ["march", "mar", "март", "марта", "мар"], ["april", "apr", "апрель", "апреля", "апр"],
  ["may", "май", "мая"], ["june", "jun", "июнь", "июня", "июн"], ["july", "jul", "июль", "июля", "июл"],
  ["august", "aug", "август", "августа", "авг"], ["september", "sep", "sept", "сентябрь", "сентября", "сен", "сент"],
  ["october", "oct", "октябрь", "октября", "окт"], ["november", "nov", "ноябрь", "ноября", "ноя", "нояб"],
  ["december", "dec", "декабрь", "декабря", "дек"],
].forEach((names, index) => names.forEach((name) => { MONTHS[name] = index + 1; }));
const monthPattern = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const yearPattern = "(?:[, \\t]+(?<year>\\d{4}|\\d{2})(?![\\d:]))?";
const dayMonth = new RegExp(`(?<![\\p{L}\\d])(?<day>\\d{1,2})[ \\t]+(?<month>${monthPattern})\\.?(?!\\p{L})${yearPattern}`, "giu");
const monthDay = new RegExp(`(?<!\\p{L})(?<month>${monthPattern})\\.?[ \\t]+(?<day>\\d{1,2})(?![\\p{L}\\d])${yearPattern}`, "giu");
const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const numeric = /(?<![\d/.])(\d{1,2})([/.])(\d{1,2})(?:\2(\d{4}|\d{2})(?!\d))?(?![\d/.])/g;
type Found = { start: number; end: number; day: number; month: number; year?: number; yearText?: string; numeric?: [number, number] };
const ymd = (year: number, month: number, day: number) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const valid = (year: number, month: number, day: number) => year >= 1 && year <= 9999 && calendarDate(ymd(year, month, day));

function expressions(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(iso)) found.push({ start: match.index!, end: match.index! + match[0].length, year: Number(match[1]), yearText: match[1], month: Number(match[2]), day: Number(match[3]) });
  for (const pattern of [dayMonth, monthDay]) for (const match of text.matchAll(pattern)) {
    const yearText = match.groups!.year;
    found.push({ start: match.index!, end: match.index! + match[0].length, month: MONTHS[match.groups!.month!.toLowerCase()]!, day: Number(match.groups!.day), year: yearText ? Number(yearText) : undefined, yearText });
  }
  for (const match of text.matchAll(numeric)) found.push({ start: match.index!, end: match.index! + match[0].length, day: Number(match[1]), month: Number(match[3]), numeric: [Number(match[1]), Number(match[3])], year: match[4] ? Number(match[4]) : undefined, yearText: match[4] });
  const selected: Found[] = [];
  for (const candidate of found.sort((a, b) => a.start - b.start || b.end - a.end)) if (!selected.some((prior) => candidate.start < prior.end && candidate.end > prior.start)) selected.push(candidate);
  return selected;
}

function dateFields(found: Found, context: SyllabusDateContext, proposal: SyllabusDateProposal): string | null {
  if (found.yearText && found.yearText.length !== 4) { proposal.reasons.push("Two-digit years are unsupported; specify a four-digit year."); return null; }
  let day = found.day, month = found.month; const year = found.year;
  if (found.numeric) {
    if (context.conflictingDateOrder || (context.dateOrder && !["DMY", "MDY"].includes(context.dateOrder))) { proposal.reasons.push("Document/course date-order metadata is invalid or conflicting."); return null; }
    const [first, second] = found.numeric;
    const options = [{ day: first, month: second, order: "DMY" }, { day: second, month: first, order: "MDY" }].filter((candidate) => valid(year ?? 2000, candidate.month, candidate.day));
    const chosen = context.dateOrder ? options.filter((option) => option.order === context.dateOrder) : options;
    if (!chosen.length) { proposal.state = "invalid"; proposal.reasons.push("The source contains an impossible calendar date."); return null; }
    if (chosen.length > 1 && (chosen[0]!.day !== chosen[1]!.day || chosen[0]!.month !== chosen[1]!.month)) { proposal.reasons.push("Ambiguous numeric day/month; declare document/course DMY or MDY order."); return null; }
    day = chosen[0]!.day; month = chosen[0]!.month;
  }
  if (!valid(year ?? 2000, month, day)) { proposal.state = "invalid"; proposal.reasons.push("The source contains an impossible calendar date."); return null; }
  if (year === undefined) {
    const semester = context.semester;
    if (!semester) { proposal.reasons.push("Missing year; no explicit semester start/end supplied."); return null; }
    if (!calendarDate(semester.start) || !calendarDate(semester.end) || semester.start > semester.end || Number(semester.end.slice(0, 4)) - Number(semester.start.slice(0, 4)) > 5) { proposal.reasons.push("Explicit semester bounds are invalid or exceed five years."); return null; }
    const placements: string[] = [];
    for (let candidate = Number(semester.start.slice(0, 4)); candidate <= Number(semester.end.slice(0, 4)); candidate++) {
      const date = ymd(candidate, month, day); if (valid(candidate, month, day) && date >= semester.start && date <= semester.end) placements.push(date);
    }
    if (placements.length !== 1) { proposal.reasons.push("Missing year has zero or multiple placements in the explicit semester bounds."); return null; }
    proposal.yearInferredFrom = { ...semester }; proposal.reasons.push("Year inferred only from unique placement in explicit semester bounds; review required.");
    return placements[0]!;
  }
  return ymd(year, month, day);
}

const zoneToken = (value: string) => /^(?:Z|UTC|[+-]\d{2}:\d{2}|[A-Za-z_+-]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/iu.test(value);
const clockBoundary = (value: string) => /^(?:and|or|opens?|opening|closes?|closing|due|deadline|и|или|начало|закрытие|срок)$/iu.test(value)
  || /^(?:in|on|for|with|at|please|room|bring|note|classroom|в|на|аудитории|пожалуйста)$/u.test(value);
const zoneLooking = (value: string) => zoneToken(value) || /^(?:Z|UTC|GMT)/iu.test(value) || /^[+−-]/u.test(value)
  || value.includes("/") || /^(?:a\.?m\.?|p\.?m\.?)$/iu.test(value) || /^[\d.:]/u.test(value)
  || /^(?:noon|midnight|полдень|полночь)$/iu.test(value)
  || (/[\p{L}]/u.test(value) && value === value.toUpperCase());
const clockPayload = (value: string) => !value || /^(?:[\d+−:-]|a\.?m\.?\b|p\.?m\.?\b|noon\b|midnight\b|полдень(?!\p{L})|полночь(?!\p{L}))/iu.test(value);

/** Lex the whole associated clock first; only then may trusted zone context apply. */
function clockContinuation(tail: string): { length: number; unsupported: boolean; clock?: { hour: string; minute: string; zone?: string } } {
  const horizontal = /^[^\S\r\n]*/u.exec(tail)![0].length;
  let cursor = 0, intent = false;
  if (/^T/i.test(tail)) { cursor = 1; intent = true; }
  else {
    const afterSpace = tail.slice(horizontal);
    if (horizontal && /^T(?:\d|$)/i.test(afterSpace)) { cursor = horizontal + 1; intent = true; }
    else {
      const introduced = /^(?:at|в)(?!\p{L})[^\S\r\n]*/iu.exec(afterSpace);
      const payload = introduced ? afterSpace.slice(introduced[0].length) : "";
      if (horizontal && introduced && clockPayload(payload)) { cursor = horizontal + introduced[0].length; intent = true; }
      else if (horizontal && /^\d+(?::|[^\S\r\n]*(?:a\.?m\.?|p\.?m\.?))/iu.test(afterSpace)) { cursor = horizontal; intent = true; }
    }
  }
  if (!intent) return { length: 0, unsupported: false };
  // Read lexical tokens, not just a supported HH:mm prefix. A bare T is still intent.
  const token = /^[^\s,;!?()[\]{}]+/u.exec(tail.slice(cursor))?.[0] ?? "";
  cursor += token.length;
  let unsupported = false;
  const core = /^(\d{1,2}):(\d{2})(.*)$/u.exec(token);
  const zones: { value: string; unsupportedSyntax: boolean }[] = [];
  if (!core) unsupported = true;
  else {
    let attached = core[3]!;
    // A sentence-ending period is punctuation only after an otherwise complete token.
    if (attached.endsWith(".") && (!attached.slice(0, -1) || zoneToken(attached.slice(0, -1)))) { attached = attached.slice(0, -1); cursor--; }
    if (attached) zones.push({ value: attached, unsupportedSyntax: false });
  }
  for (let index = 0; index < 8; index++) {
    const rest = tail.slice(cursor);
    const separator = /^[^\S\r\n]*(?:[,.:)\]][^\S\r\n]*)*/u.exec(rest)![0];
    let position = cursor + separator.length;
    const char = tail[position];
    if (!char || /[\r\n;!?]/u.test(char)) break;
    if (char === "(" || char === "[") {
      const close = char === "(" ? ")" : "]";
      const finish = tail.indexOf(close, position + 1);
      // An unclosed wrapper retains its first token, without absorbing later prose.
      const incomplete = /^[^\S\r\n]*[^\s,;!?()[\]{}]*/u.exec(tail.slice(position + 1))![0];
      const end = finish >= 0 ? finish + 1 : position + 1 + incomplete.length;
      zones.push({ value: tail.slice(position, end), unsupportedSyntax: true }); cursor = end; continue;
    }
    const word = /^[^\s,;!?()[\]{}]+/u.exec(tail.slice(position))?.[0];
    if (!word) break;
    const next = tail.slice(position + word.length).replace(/^[^\S\r\n]*/u, "");
    // A second clock introducer is evidence, whereas "at campus" is ordinary prose.
    if (/^(?:at|в)$/iu.test(word) && clockPayload(next)) {
      zones.push({ value: word, unsupportedSyntax: true }); cursor = position + word.length; continue;
    }
    if (/^(?:and|or|и|или)$/iu.test(word)) {
      const following = /^[^\s,;!?()[\]{}]+/u.exec(next)?.[0];
      const secondClock = /^(?:at|в)[^\S\r\n]+/iu.exec(next);
      if ((following && !clockBoundary(following) && zoneLooking(following)) || (secondClock && clockPayload(next.slice(secondClock[0].length)))) {
        zones.push({ value: word, unsupportedSyntax: true }); cursor = position + word.length; continue;
      }
      break;
    }
    if (clockBoundary(word) || !zoneLooking(word)) break;
    // Closing punctuation alone terminates prose; other tokens must be interpreted fully.
    let value = word;
    if (value.endsWith(".") && zoneToken(value.slice(0, -1))) value = value.slice(0, -1);
    zones.push({ value, unsupportedSyntax: /[,.:)\]]/u.test(separator) });
    position += value.length; cursor = position;
  }
  if (zones.length > 1 || zones.some((zone) => zone.unsupportedSyntax || !zoneToken(zone.value))) unsupported = true;
  if (!core) return { length: cursor, unsupported: true };
  const written = zones[0]?.value;
  return { length: cursor, unsupported, clock: { hour: core[1]!, minute: core[2]!, zone: written && /^(?:Z|UTC)$/iu.test(written) ? written.toUpperCase() : written } };
}

export function parseSyllabusMention(mention: AssessmentMention, context: SyllabusDateContext = {}): ParsedAssessmentMention {
  const text = mention.rawScheduleText; const found = expressions(text);
  if (found.length > 100) throw new Error("A source row has too many date expressions. Split or review the row.");
  const dates: SyllabusDateProposal[] = found.map((expression) => {
    const prefix = text.slice(Math.max(0, expression.start - 40), expression.start);
    const label = /(?:opens?|opening|available from|closes?|closing|due|deadline|открытие|начало|закрытие|срок|до)[ \t]*[:—-]?[ \t]*$/iu.exec(prefix)?.[0].trim();
    const proposal: SyllabusDateProposal = { id: "", parentId: mention.id, expression: "", start: expression.start, end: expression.end, label, date: { kind: "unknown" }, status: "unconfirmed", state: "unresolved", reasons: [] };
    const tail = text.slice(expression.end);
    const continuation = clockContinuation(tail), time = continuation.clock;
    proposal.end += continuation.length;
    const unsupportedYear = !expression.yearText && /^[, \t]+\d+(?![\d:])/u.exec(tail);
    if (unsupportedYear && !continuation.length) proposal.end += unsupportedYear[0].length;
    proposal.expression = text.slice(proposal.start, proposal.end);
    proposal.id = `${mention.id}/date:${proposal.start}:${proposal.end}:${label ?? ""}`;
    if (/(?:after|before|around|approximately|после|около)[ \t]*$/iu.test(prefix)) { proposal.reasons.push("Relative date wording is unsupported; preserve it for review."); return proposal; }
    if (unsupportedYear || continuation.unsupported) { proposal.reasons.push("Unsupported year, clock or timezone wording; the complete written expression requires review and cannot use a fallback timezone."); return proposal; }
    const date = dateFields(expression, context, proposal);
    if (!date) return proposal;
    if (!time) { proposal.date = { kind: "date", date }; proposal.state = "proposed"; return proposal; }
    const clock = `${time.hour.padStart(2, "0")}:${time.minute}`; proposal.wallTime = { date, time: clock };
    if (Number(time.hour) > 23 || Number(time.minute) > 59) { proposal.state = "invalid"; proposal.reasons.push("The source contains an impossible hour or minute."); return proposal; }
    const written = time.zone;
    if (written && /^(Z|[+-])/i.test(written)) {
      if (written.toUpperCase() !== "Z" && (Number(written.slice(1, 3)) > 14 || Number(written.slice(4)) > 59 || (Number(written.slice(1, 3)) === 14 && Number(written.slice(4)) !== 0))) { proposal.state = "invalid"; proposal.reasons.push("The written UTC offset is outside the supported ±14:00 range."); return proposal; }
      proposal.zoneProvenance = { kind: "offset", value: written };
      proposal.date = { kind: "exact", iso: `${date}T${clock}:00${written.toUpperCase()}`, tz: "UTC" }; proposal.state = "proposed"; return proposal;
    }
    const zone = written ?? context.timezone?.zone;
    if (!zone) { proposal.reasons.push("Written time needs an explicit source offset or trusted document/course timezone."); return proposal; }
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { proposal.reasons.push("The document/source IANA timezone is invalid or unsupported."); return proposal; }
    const instants = zonedInstants(`${date}T${clock}`, zone);
    if (instants.length !== 1) { proposal.reasons.push(instants.length ? "This local time is ambiguous during a timezone overlap." : "This local time does not exist during a timezone gap."); return proposal; }
    proposal.zoneProvenance = { kind: written ? "written_iana" : context.timezone!.source, value: zone };
    proposal.date = { kind: "exact", iso: instants[0]!, tz: zone }; proposal.state = "proposed"; return proposal;
  });
  const multipleMentions = mention.reasons.some((reason) => reason.startsWith("Multiple assessment mentions"));
  const extraClock = [...text.matchAll(/\d{1,2}:\d{2}/g)].some((clock) => !dates.some((date) => clock.index! >= date.start && clock.index! + clock[0].length <= date.end));
  const labelRole = (label: string) => /open|opening|available|открыт|начало/iu.test(label) ? "opens" : /clos|закрыт/iu.test(label) ? "closes" : "due";
  const distinctLabels = dates.length > 1 && dates.every((date) => date.label) && new Set(dates.map((date) => labelRole(date.label!))).size === dates.length;
  if (multipleMentions || (dates.length > 1 && !distinctLabels)) for (const proposal of dates) { proposal.date = { kind: "unknown" }; proposal.state = "unresolved"; proposal.reasons.push(multipleMentions ? "Multiple mentions share this source row; date association is ambiguous." : "Several dates or a range share this source row without distinct reliable labels."); }
  if (extraClock) for (const proposal of dates) { proposal.date = { kind: "unknown" }; proposal.state = "unresolved"; proposal.reasons.push("Additional or preceding written time has no reliable date association."); }
  if (!dates.length) dates.push({ id: `${mention.id}/date:unresolved`, parentId: mention.id, expression: text, start: 0, end: text.length, date: { kind: "unknown" }, status: "unconfirmed", state: "unresolved", reasons: ["No supported explicit date expression. Relative wording and teaching weeks remain unresolved."] });
  return { mention, dates };
}
