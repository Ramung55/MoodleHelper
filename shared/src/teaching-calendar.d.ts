export type PartialBreak = { startDate: string; endDate: string; numbering: 'preserve' | 'unresolved' };
export type Calendar = { startDate: string; endDate: string; timezone: string; excludedWeekStarts: string[]; partialBreaks?: PartialBreak[]; weekOverrides?: {week: number; startDate: string; endDate: string}[] };
export type TeachingRange = {week: number; holidays: PartialBreak[]} & ({resolved: true; start: string; end: string; override: boolean} | {resolved: false; reason: string});
export const teachingTimezones: string[];
export function realCalendarDate(value: unknown): boolean;
export function teachingCalendarError(value: unknown): string | null;
export function teachingSlots(value: unknown): { start: string; end: string; week: number | null }[];
export function teachingRanges(value: unknown): TeachingRange[];
