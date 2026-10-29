import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/app-store";
import type { TeachingCalendar } from "@/domain/types";
import { teachingCalendarError, teachingSlots } from "@/domain/teaching-weeks";
import { teachingTimezones } from "../../../../shared/src/teaching-calendar.js";

const empty = (): TeachingCalendar => ({ startDate: "", endDate: "", timezone: "", excludedWeekStarts: [] });
export function TeachingCalendarSettings() {
  const { snap, run } = useApp(); const saved = snap?.settings.teachingCalendar;
  const [draft, setDraft] = useState<TeachingCalendar>(saved ? structuredClone(saved) : empty());
  const [excluded, setExcluded] = useState(saved?.excludedWeekStarts.join(", ") ?? "");
  const [pending, setPending] = useState(false), [failure, setFailure] = useState("");
  const dirty = useRef(false), busy = useRef(false);
  useEffect(() => { if (!dirty.current) { setDraft(saved ? structuredClone(saved) : empty()); setExcluded(saved?.excludedWeekStarts.join(", ") ?? ""); } }, [saved]);
  const calendar = { ...draft, excludedWeekStarts: excluded.trim() ? excluded.split(",").map((part) => part.trim()) : [] };
  const error = teachingCalendarError(calendar), slots = error ? [] : teachingSlots(calendar);
  const reset = () => { dirty.current = false; setDraft(saved ? structuredClone(saved) : empty()); setExcluded(saved?.excludedWeekStarts.join(", ") ?? ""); setFailure(""); };
  return <section className="rounded-lg border bg-card p-5"><h2 className="mb-3 text-lg font-semibold">Explicit teaching calendar</h2>
    <p className="mb-2 text-sm">{saved ? `Saved calendar: ${saved.startDate}–${saved.endDate}, ${saved.timezone}.` : "Teaching calendar not configured. Legacy/sample semester fields do not establish a teaching-week map."}</p>
    <p className="mb-3 text-xs text-muted-foreground">Enter both inclusive boundaries. This version supports complete seven-day slots anchored to your start, at most 60 calendar slots and 30 teaching weeks. Exclusions are full slot start dates, not teaching-week numbers. Partial weeks and irregular overrides need separate support.</p>
    <form noValidate onSubmit={async (event) => {
      event.preventDefault(); if (busy.current) return; setFailure("");
      if (error) { setFailure(error); return; }
      busy.current = true; setPending(true);
      const ok = await run((api) => api.updateSettings({ teachingCalendar: calendar }));
      busy.current = false; setPending(false);
      if (ok) dirty.current = false; else setFailure("Calendar was not saved. Your draft is retained; the previous saved map remains active. Retry when the backend is available.");
    }}>
      <fieldset disabled={pending} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">{([['startDate','Inclusive calendar start'],['endDate','Inclusive calendar end']] as const).map(([key,label]) => <label key={key} className="text-sm">{label}<Input type="date" aria-label={label} value={draft[key]} onChange={(event) => { dirty.current = true; setDraft((value) => ({ ...value, [key]: event.target.value })); }} /></label>)}</div>
        <label className="block text-sm">Calendar timezone<select aria-label="Calendar timezone" className="mt-1 h-9 w-full rounded-md border bg-card px-2" value={draft.timezone} onChange={(event) => { dirty.current = true; setDraft((value) => ({ ...value, timezone: event.target.value })); }}><option value="">Choose a supported IANA timezone</option>{teachingTimezones.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
        <label className="block text-sm">Excluded full-week start dates<Input aria-label="Excluded full-week start dates" value={excluded} placeholder="2027-01-18, 2027-02-01" onChange={(event) => { dirty.current = true; setExcluded(event.target.value); }} /></label>
        {error && <p className="text-sm text-destructive">Draft: {error}</p>}{failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        {slots.length > 0 && <div className="max-h-64 overflow-y-auto"><table className="w-full text-left text-sm"><caption className="text-left font-semibold">Draft calendar preview ({calendar.timezone})</caption><thead><tr><th>Start</th><th>End (inclusive)</th><th>Teaching week</th></tr></thead><tbody>{slots.map((slot) => <tr key={slot.start}><td>{slot.start}</td><td>{slot.end}</td><td>{slot.week === null ? "Break — counter paused" : `Week ${slot.week}`}</td></tr>)}</tbody></table></div>}
        <div className="flex gap-2"><Button type="submit">{pending ? "Saving calendar…" : "Save teaching calendar"}</Button><Button type="button" variant="outline" onClick={reset}>Cancel calendar draft</Button></div>
      </fieldset>
    </form>
  </section>;
}
