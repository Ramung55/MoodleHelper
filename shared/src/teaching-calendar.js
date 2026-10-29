import timezones from './teaching-timezones.json' with { type: 'json' };
export { timezones as teachingTimezones };
export function realCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
export function teachingCalendarError(value) {
  const required = ['startDate', 'endDate', 'timezone', 'excludedWeekStarts'], allowed = [...required, 'partialBreaks', 'weekOverrides'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) return 'Supply the complete teaching calendar with start, end, timezone and excluded slot starts.';
  if (!realCalendarDate(value.startDate) || !realCalendarDate(value.endDate)) return 'Enter real calendar start and end dates.';
  if (!timezones.includes(value.timezone)) return 'Choose a supported IANA calendar timezone.';
  const start = Date.parse(value.startDate + 'T00:00:00Z'), end = Date.parse(value.endDate + 'T00:00:00Z');
  const days = (end - start) / 86400000 + 1;
  if (days < 7 || days % 7 || days > 420) return 'Inclusive boundaries must form 1–60 complete seven-day calendar slots.';
  if (!Array.isArray(value.excludedWeekStarts) || value.excludedWeekStarts.length > 59 || new Set(value.excludedWeekStarts).size !== value.excludedWeekStarts.length) return 'Use at most 59 distinct excluded slot starts.';
  for (const excluded of value.excludedWeekStarts) {
    if (!realCalendarDate(excluded)) return 'Every excluded slot start must be a real calendar date.';
    const offset = (Date.parse(excluded + 'T00:00:00Z') - start) / 86400000;
    if (offset < 0 || offset % 7 || offset + 6 >= days) return 'Excluded weeks must be full seven-day slots aligned to the calendar start and inside its boundaries.';
  }
  const teaching = days / 7 - value.excludedWeekStarts.length;
  if (teaching < 1 || teaching > 30) return 'The calendar must contain 1–30 nonexcluded teaching weeks.';
  for (const [key, max] of [['partialBreaks', 60], ['weekOverrides', 30]]) if (Object.hasOwn(value, key) && (!Array.isArray(value[key]) || value[key].length > max)) return `Use at most ${max} ${key} entries; null is unsupported.`;
  const partials = value.partialBreaks ?? [], overrides = value.weekOverrides ?? [], slots = baselineSlots(value);
  const shape = (item, keys) => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).sort().join(',') === [...keys].sort().join(',');
  const bounded = item => realCalendarDate(item.startDate) && realCalendarDate(item.endDate) && item.startDate <= item.endDate && item.startDate >= value.startDate && item.endDate <= value.endDate;
  for (const partial of partials) {
    if (!shape(partial, ['startDate', 'endDate', 'numbering']) || !['preserve', 'unresolved'].includes(partial.numbering) || !bounded(partial)) return 'Every partial break needs real bounded start/end dates and an explicit preserve or unresolved numbering choice.';
    const slot = slots.find(slot => partial.startDate >= slot.start && partial.endDate <= slot.end);
    if (!slot || slot.week === null || (Date.parse(partial.endDate) - Date.parse(partial.startDate)) / 86400000 >= 6) return 'A partial break must be shorter than seven days within one nonexcluded anchored slot.';
  }
  for (let index = 0; index < partials.length; index++) if (partials.slice(index + 1).some(other => overlaps(partials[index].startDate, partials[index].endDate, other.startDate, other.endDate))) return 'Partial breaks must not overlap, including inclusive endpoints.';
  const seen = new Set();
  for (const override of overrides) {
    if (!shape(override, ['week', 'startDate', 'endDate']) || !Number.isInteger(override.week) || override.week < 1 || override.week > 30 || !bounded(override)) return 'Every override needs a week integer 1–30 and real, ordered dates within the semester.';
    if (seen.has(override.week)) return 'Each overridden week number must be unique.';
    seen.add(override.week);
    if (slots.some(slot => slot.week === null && overlaps(override.startDate, override.endDate, slot.start, slot.end))) return 'An explicit override cannot occupy a full excluded week.';
  }
  const resolved = rangesUnchecked(value).filter(range => range.resolved);
  for (let index = 0; index < resolved.length; index++) for (const other of resolved.slice(index + 1)) if (overlaps(resolved[index].start, resolved[index].end, other.start, other.end)) return `Resolved Week ${resolved[index].week} overlaps Week ${other.week}; adjust both ranges explicitly.`;
  return null;
}
const overlaps = (start, end, otherStart, otherEnd) => start <= otherEnd && otherStart <= end;
function baselineSlots(value) {
  const slots = []; let week = 0;
  for (let at = Date.parse(value.startDate + 'T00:00:00Z'); at <= Date.parse(value.endDate + 'T00:00:00Z'); at += 7 * 86400000) {
    const start = new Date(at).toISOString().slice(0, 10), end = new Date(at + 6 * 86400000).toISOString().slice(0, 10);
    const excluded = value.excludedWeekStarts.includes(start);
    slots.push({ start, end, week: excluded ? null : ++week });
  }
  return slots;
}
export function teachingSlots(value) { return teachingCalendarError(value) ? [] : baselineSlots(value); }
function rangesUnchecked(value) {
  const partials = value.partialBreaks ?? [], overrides = value.weekOverrides ?? [];
  const firstUnknown = partials.filter(partial => partial.numbering === 'unresolved').map(partial => partial.startDate).sort()[0];
  const ranges = new Map(baselineSlots(value).filter(slot => slot.week !== null).map(slot => [slot.week, firstUnknown && slot.end >= firstUnknown
    ? { week: slot.week, resolved: false, reason: 'Institutional numbering is unresolved from a partial holiday; supply an explicit range for this week.', holidays: [] }
    : { ...slot, resolved: true, override: false, holidays: [] }]));
  for (const override of overrides) ranges.set(override.week, { week: override.week, start: override.startDate, end: override.endDate, resolved: true, override: true, holidays: [] });
  return [...ranges.values()].sort((a, b) => a.week - b.week).map(range => ({ ...range, holidays: range.resolved ? partials.filter(partial => overlaps(range.start, range.end, partial.startDate, partial.endDate)).sort((a, b) => a.startDate < b.startDate ? -1 : 1) : [] }));
}
export function teachingRanges(value) { return teachingCalendarError(value) ? [] : rangesUnchecked(value); }
