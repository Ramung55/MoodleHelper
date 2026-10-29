import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/app-store";
import type { TeachingCalendar } from "@/domain/types";
import { teachingCalendarError, teachingSlots, teachingRanges } from "@/domain/teaching-weeks";
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
  const error = teachingCalendarError(calendar), slots = error ? [] : teachingSlots(calendar), ranges = error ? [] : teachingRanges(calendar);
  const edit = (fn: (value: TeachingCalendar) => TeachingCalendar) => { dirty.current = true; setDraft(fn); };
  const reset = () => { dirty.current = false; setDraft(saved ? structuredClone(saved) : empty()); setExcluded(saved?.excludedWeekStarts.join(", ") ?? ""); setFailure(""); };
  return <section className="rounded-lg border bg-card p-5"><h2 className="mb-3 text-lg font-semibold">Explicit teaching calendar</h2>
    <p className="mb-2 text-sm">{saved ? `Saved calendar: ${saved.startDate}–${saved.endDate}, ${saved.timezone}.` : "Teaching calendar not configured. Legacy/sample semester fields do not establish a teaching-week map."}</p>
    <p className="mb-3 text-xs text-muted-foreground">Enter both inclusive boundaries as complete seven-day baseline slots, at most 60 calendar slots and 30 baseline teaching weeks. Full exclusions pause counting. Partial holidays annotate days without shifting numbering; explicitly confirm preserve or leave numbering unresolved. An explicit override changes only its named week, never its neighbors. These are your settings, not observed institutional numbering.</p>
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
        <div className="space-y-2 rounded border p-3"><h3 className="font-medium">Partial holidays</h3><p className="text-xs">Each interval is shorter than seven days within one anchored nonexcluded slot. Unknown numbering leaves that and following baseline weeks unresolved until individually overridden.</p>
          {(draft.partialBreaks ?? []).map((partial, index) => <div key={index} className="grid gap-2 sm:grid-cols-4">
            {([['startDate','start'],['endDate','end']] as const).map(([key,label]) => <label key={key} className="text-xs">Holiday {index + 1} {label}<Input type="date" aria-label={`Holiday ${index + 1} ${label}`} value={partial[key]} onChange={event => edit(value => ({ ...value, partialBreaks: value.partialBreaks!.map((item, at) => at === index ? { ...item, [key]: event.target.value } : item) }))} /></label>)}
            <label className="text-xs">Holiday {index + 1} numbering<select aria-label={`Holiday ${index + 1} numbering`} className="h-9 w-full rounded border bg-card" value={partial.numbering} onChange={event => edit(value => ({ ...value, partialBreaks: value.partialBreaks!.map((item, at) => at === index ? { ...item, numbering: event.target.value as "preserve" | "unresolved" } : item) }))}><option value="unresolved">Unknown — unresolved</option><option value="preserve">I confirm numbering stays unchanged</option></select></label>
            <Button type="button" variant="outline" onClick={() => edit(value => ({ ...value, partialBreaks: value.partialBreaks!.filter((_, at) => at !== index) }))}>Remove holiday {index + 1}</Button>
          </div>)}
          <Button type="button" variant="outline" disabled={(draft.partialBreaks?.length ?? 0) >= 60} onClick={() => edit(value => ({ ...value, partialBreaks: [...value.partialBreaks ?? [], { startDate: "", endDate: "", numbering: "unresolved" }] }))}>Add partial holiday</Button>
        </div>
        <div className="space-y-2 rounded border p-3"><h3 className="font-medium">Explicit teaching-week ranges</h3><p className="text-xs">Ranges may be any positive length within the semester. Inclusive overlap with another resolved week or full excluded slot is invalid. Adjust all conflicting weeks together; nothing shifts automatically.</p>
          {(draft.weekOverrides ?? []).map((override, index) => <div key={index} className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs">Override {index + 1} week<Input type="number" min={1} max={30} aria-label={`Override ${index + 1} week`} value={Number.isNaN(override.week) ? "" : override.week} onChange={event => edit(value => ({ ...value, weekOverrides: value.weekOverrides!.map((item, at) => at === index ? { ...item, week: event.target.value.trim() ? Number(event.target.value) : NaN } : item) }))} /></label>
            {([['startDate','start'],['endDate','end']] as const).map(([key,label]) => <label key={key} className="text-xs">Override {index + 1} {label}<Input type="date" aria-label={`Override ${index + 1} ${label}`} value={override[key]} onChange={event => edit(value => ({ ...value, weekOverrides: value.weekOverrides!.map((item, at) => at === index ? { ...item, [key]: event.target.value } : item) }))} /></label>)}
            <Button type="button" variant="outline" onClick={() => edit(value => ({ ...value, weekOverrides: value.weekOverrides!.filter((_, at) => at !== index) }))}>Remove override {index + 1}</Button>
          </div>)}
          <Button type="button" variant="outline" disabled={(draft.weekOverrides?.length ?? 0) >= 30} onClick={() => edit(value => ({ ...value, weekOverrides: [...value.weekOverrides ?? [], { week: 1, startDate: "", endDate: "" }] }))}>Add week override</Button>
        </div>
        {error && <p className="text-sm text-destructive">Draft: {error}</p>}{failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        {slots.length > 0 && <div className="max-h-64 overflow-y-auto"><table className="w-full text-left text-sm"><caption className="text-left font-semibold">Draft calendar preview ({calendar.timezone})</caption><thead><tr><th>Start</th><th>End (inclusive)</th><th>Teaching week</th><th>Explicit assertions</th></tr></thead><tbody>{ranges.map(range => <tr key={range.week}><td>{range.resolved ? range.start : "Unresolved"}</td><td>{range.resolved ? range.end : "Unresolved"}</td><td>{`Week ${range.week}`}{!range.resolved && ` — ${range.reason}`}</td><td>{range.resolved && <>{range.override && "Explicit override. "}{range.holidays.map(holiday => `${holiday.startDate}–${holiday.endDate}: ${holiday.numbering}`).join("; ")}</>}</td></tr>)}{slots.filter(slot => slot.week === null).map(slot => <tr key={slot.start}><td>{slot.start}</td><td>{slot.end}</td><td>Break — counter paused</td><td>Full exclusion</td></tr>)}</tbody></table></div>}
        <div className="flex gap-2"><Button type="submit">{pending ? "Saving calendar…" : "Save teaching calendar"}</Button><Button type="button" variant="outline" onClick={reset}>Cancel calendar draft</Button></div>
      </fieldset>
    </form>
  </section>;
}
