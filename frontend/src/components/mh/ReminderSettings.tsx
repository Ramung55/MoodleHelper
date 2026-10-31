import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useApp } from "@/lib/app-store";
import { REMINDER_DEFAULTS, REMINDER_MAX_HOURS, type ReminderPlan, type Settings } from "@/domain/types";

const CLOCK = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const REASONS: Record<string, string> = {
  disabled: "Reminders are off.",
  invalid_lead_time: `Saved lead time is invalid; choose 0–${REMINDER_MAX_HOURS} hours.`,
  timezone_data_unavailable: "Timezone data is unavailable on the backend.",
  calendar_missing: "Set the teaching calendar to schedule date-only and busy-week reminders.",
  calendar_invalid: "The saved teaching calendar is invalid.",
  date_unknown: "Deadline unknown.",
  week_outside_calendar: "Week is outside the teaching calendar.",
  date_outside_calendar: "Date is outside the teaching calendar.",
  local_time_ambiguous: "Local reminder time falls in a clock change; pick another time.",
  invalid_weights: "Workload weights are invalid.",
};

/** Validate a reminders patch; undefined means OK. Invalid values are never saved or clamped. */
export function reminderError(r: Settings["reminders"]): string | undefined {
  if (!Number.isFinite(r.hoursBefore) || r.hoursBefore < 0 || r.hoursBefore > REMINDER_MAX_HOURS) return `Hours before must be 0–${REMINDER_MAX_HOURS}.`;
  const lead = r.busyWeekLeadDays ?? REMINDER_DEFAULTS.busyWeekLeadDays;
  if (!Number.isInteger(lead) || lead < 0 || lead > 30) return "Busy-week lead must be 0–30 days.";
  for (const v of [r.dateOnlyLocalTime, r.busyWeekLocalTime]) if (v !== undefined && !CLOCK.test(v)) return "Times must be HH:mm.";
  return undefined;
}

export function ReminderSettingsPanel() {
  const { snap, adapter, run } = useApp();
  const [error, setError] = useState<string>();
  const [plan, setPlan] = useState<ReminderPlan | null>(null);
  const [planNote, setPlanNote] = useState("Loading reminder preview…");
  const r = snap?.settings.reminders;
  useEffect(() => {
    let alive = true;
    if (!adapter?.reminderPlan) { setPlanNote("Reminder schedule preview needs the local backend."); return; }
    adapter.reminderPlan().then((p) => { if (alive) { setPlan(p); setPlanNote(""); } })
      .catch(() => alive && setPlanNote("Reminder schedule preview is unavailable. Start the backend and reload."));
    return () => { alive = false; };
  }, [adapter, r]);
  if (!r) return null;
  const save = (patch: Partial<Settings["reminders"]>) => {
    const next = { ...r, ...patch };
    const message = reminderError(next);
    setError(message);
    if (!message) void run((a) => a.updateSettings({ reminders: next }));
  };
  const scheduled = plan?.items.filter((i) => i.status === "scheduled") ?? [];
  return <div className="space-y-3 text-sm">
    <label className="flex items-center justify-between">Reminders on <Switch checked={r.enabled} onCheckedChange={(v) => save({ enabled: v })} /></label>
    <label className="flex items-center justify-between">Busy-week warnings <Switch checked={r.busyWeek} onCheckedChange={(v) => save({ busyWeek: v })} /></label>
    <div className="flex items-center justify-between gap-2"><Label htmlFor="hb">Remind this many hours before exact deadlines</Label><Input id="hb" type="number" min={0} max={REMINDER_MAX_HOURS} className="w-24" defaultValue={r.hoursBefore} key={`hb${r.hoursBefore}`} onBlur={(e) => save({ hoursBefore: Number(e.target.value) })} /></div>
    <p className="text-xs text-muted-foreground">Saved: {r.hoursBefore} h (default {REMINDER_DEFAULTS.hoursBefore} h).</p>
    <div className="flex items-center justify-between gap-2"><Label htmlFor="dot">Date-only reminder time (day before)</Label><Input id="dot" type="time" className="w-28" defaultValue={r.dateOnlyLocalTime ?? REMINDER_DEFAULTS.dateOnlyLocalTime} key={`dot${r.dateOnlyLocalTime}`} onBlur={(e) => save({ dateOnlyLocalTime: e.target.value })} /></div>
    <div className="flex items-center justify-between gap-2"><Label htmlFor="bwl">Busy-week warning days ahead</Label><Input id="bwl" type="number" min={0} max={30} className="w-24" defaultValue={r.busyWeekLeadDays ?? REMINDER_DEFAULTS.busyWeekLeadDays} key={`bwl${r.busyWeekLeadDays}`} onBlur={(e) => save({ busyWeekLeadDays: Number(e.target.value) })} /></div>
    <div className="flex items-center justify-between gap-2"><Label htmlFor="bwt">Busy-week warning time</Label><Input id="bwt" type="time" className="w-28" defaultValue={r.busyWeekLocalTime ?? REMINDER_DEFAULTS.busyWeekLocalTime} key={`bwt${r.busyWeekLocalTime}`} onBlur={(e) => save({ busyWeekLocalTime: e.target.value })} /></div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div aria-label="Reminder preview" className="rounded border p-2 text-xs">
      {planNote ? <p>{planNote}</p> : <>
        {plan!.reasons.map((x) => <p key={x}>{REASONS[x] ?? x}</p>)}
        <p>{scheduled.length} reminder{scheduled.length === 1 ? "" : "s"} scheduled{plan!.nextWakeAt ? `; next at ${new Date(plan!.nextWakeAt).toLocaleString()}` : ""}.</p>
        <ul className="mt-1 space-y-0.5">{plan!.items.slice(0, 5).map((i) => <li key={i.id}>{i.label}{i.dueAt ? ` — ${new Date(i.dueAt).toLocaleString()}` : ""}{i.reason ? ` (${REASONS[i.reason] ?? i.reason})` : ""}</li>)}</ul>
      </>}
    </div>
    <p className="text-xs text-muted-foreground">Reminders are scheduled by the local backend and woken by the extension. Nothing fires while Chrome is closed or the backend is stopped; missed reminders are combined into one catch-up later.</p>
  </div>;
}
