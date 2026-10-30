import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApp } from "@/lib/app-store";
import { weeklyLoad } from "@/domain/workload";
import { draftFrom, validateDraft, WORKLOAD_DEFAULTS, type WorkloadDraft, type WorkloadDraftErrors } from "@/domain/weekly-overview";
const fields: { key: keyof WorkloadDraft; label: string; step: string }[] = [
  { key: "exam", label: "exam", step: "any" }, { key: "assignment", label: "assignment", step: "any" }, { key: "quiz", label: "quiz", step: "any" }, { key: "other", label: "other", step: "any" },
  { key: "maxOutstanding", label: "Warn above outstanding", step: "1" }, { key: "maxWeighted", label: "Warn above weighted", step: "any" },
];
/** Editable validated draft for weights and thresholds with explicit save/cancel (#37). */
export function WorkloadWeights() {
  const { snap, run, views } = useApp(); const s = snap!.settings;
  const savedKey = JSON.stringify([s.weights, s.thresholds]);
  const [draft, setDraft] = useState(() => draftFrom(s)); const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<WorkloadDraftErrors>({}); const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false); const busy = useRef(false);
  // A source refresh never overwrites an open draft.
  useEffect(() => { if (!dirty) setDraft(draftFrom(s)); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (busy.current) return;
    const { errors: found, value } = validateDraft(draft); setErrors(found);
    if (!value) { setError(null); return; }
    try { weeklyLoad(views, { ...s, ...value }, snap!); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Workload cannot be calculated with these values."); return; }
    busy.current = true; setPending(true); setError(null);
    const ok = await run(api => api.updateSettings(value));
    busy.current = false; setPending(false);
    if (ok) setDirty(false); else setError("Workload settings were not saved. Previous values and workload remain active; retry when the backend is available.");
  };
  const cancel = () => { setDraft(draftFrom(s)); setErrors({}); setError(null); setDirty(false); };
  const field = (f: typeof fields[number]) => {
    const msg = errors[f.key];
    return <div key={f.key} className="space-y-1"><Label htmlFor={`w-${f.key}`} className={f.key in s.weights ? "capitalize" : undefined}>{f.label}</Label>
      <Input id={`w-${f.key}`} type="number" min={0} step={f.step} aria-invalid={!!msg} aria-describedby={msg ? `w-${f.key}-error` : undefined} value={draft[f.key]}
        onChange={e => { setDraft({ ...draft, [f.key]: e.target.value }); setDirty(true); setErrors({ ...errors, [f.key]: undefined }); }} />
      {msg && <p id={`w-${f.key}-error`} className="text-xs text-destructive">{msg}</p>}</div>;
  };
  const d = WORKLOAD_DEFAULTS;
  return <fieldset disabled={pending} className="space-y-2">
    <p className="text-xs text-muted-foreground">Defaults: exam {d.weights.exam}, assignment {d.weights.assignment}, quiz {d.weights.quiz}, other {d.weights.other}; warn above {d.thresholds.maxOutstanding} outstanding or weighted {d.thresholds.maxWeighted}. Saved custom values are kept.</p>
    <div className="grid grid-cols-4 gap-2">{fields.slice(0, 4).map(field)}</div>
    <div className="mt-3 grid grid-cols-2 gap-2">{fields.slice(4).map(field)}</div>
    {error && <p role="alert" id="weight-error" className="text-sm text-destructive">{error}</p>}
    {dirty && !pending && <p className="text-xs text-muted-foreground">Unsaved changes. Planner and Overview still show saved values.</p>}
    {pending && <p className="text-xs">Saving workload settings…</p>}
    <div className="flex gap-2"><Button type="button" size="sm" disabled={!dirty} onClick={() => void save()}>Save workload</Button><Button type="button" size="sm" variant="outline" disabled={!dirty} onClick={cancel}>Cancel</Button></div>
  </fieldset>;
}
