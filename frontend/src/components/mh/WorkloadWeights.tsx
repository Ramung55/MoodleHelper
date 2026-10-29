import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApp } from "@/lib/app-store";
import { weightsError } from "@/domain/workload";
import type { Settings } from "@/domain/types";
const kinds = ["exam", "assignment", "quiz", "other"] as const;
const strings = (weights: Settings["weights"]) => Object.fromEntries(kinds.map(kind => [kind, String(weights[kind])])) as Record<typeof kinds[number], string>;
/** Retains the existing immediate-save controls; invalid input never changes saved weights. */
export function WorkloadWeights() {
  const { snap, run } = useApp(); const saved = snap!.settings.weights;
  const [draft, setDraft] = useState(() => strings(saved)), [error, setError] = useState(weightsError(saved));
  const [pending, setPending] = useState(false); const busy = useRef(false), dirty = useRef(false);
  useEffect(() => { if (!dirty.current) { setDraft(strings(saved)); setError(weightsError(saved)); } }, [saved]);
  return <fieldset disabled={pending} className="space-y-2"><div className="grid grid-cols-4 gap-2">{kinds.map(kind => <div key={kind} className="space-y-1"><Label htmlFor={`w-${kind}`} className="capitalize">{kind}</Label><Input id={`w-${kind}`} type="number" min={0} step="any" aria-invalid={!!error} aria-describedby="weight-error" value={draft[kind]} onChange={async event => {
    if (busy.current) return;
    dirty.current = true;
    const next = { ...draft, [kind]: event.target.value }; setDraft(next);
    const weights = Object.fromEntries(kinds.map(key => [key, next[key].trim() ? Number(next[key]) : undefined])) as Settings["weights"];
    const message = weightsError(weights); setError(message); if (message) return;
    busy.current = true; setPending(true);
    const ok = await run(api => api.updateSettings({ weights }));
    busy.current = false; setPending(false);
    if (ok) dirty.current = false; else setError("Weights were not saved. Previous values and workload remain active; retry when the backend is available.");
  }} /></div>)}</div>{error && <p role="alert" id="weight-error" className="text-sm text-destructive">{error}</p>}{pending && <p className="text-xs">Saving weights…</p>}</fieldset>;
}
