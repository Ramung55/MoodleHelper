export type Calendar = { startDate: string; endDate: string; timezone: string; excludedWeekStarts: string[] };
export const teachingTimezones: string[];
export function realCalendarDate(value: unknown): boolean;
export function teachingCalendarError(value: unknown): string | null;
export function teachingSlots(value: unknown): { start: string; end: string; week: number | null }[];
