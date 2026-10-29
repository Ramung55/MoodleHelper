import timezones from './teaching-timezones.json' with { type: 'json' };
export { timezones as teachingTimezones };
export function realCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
export function teachingCalendarError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'endDate,excludedWeekStarts,startDate,timezone') return 'Supply the complete teaching calendar with start, end, timezone and excluded slot starts.';
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
  return null;
}
export function teachingSlots(value) {
  if (teachingCalendarError(value)) return [];
  const slots = []; let week = 0;
  for (let at = Date.parse(value.startDate + 'T00:00:00Z'); at <= Date.parse(value.endDate + 'T00:00:00Z'); at += 7 * 86400000) {
    const start = new Date(at).toISOString().slice(0, 10), end = new Date(at + 6 * 86400000).toISOString().slice(0, 10);
    const excluded = value.excludedWeekStarts.includes(start);
    slots.push({ start, end, week: excluded ? null : ++week });
  }
  return slots;
}
