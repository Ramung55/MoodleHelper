import type { DateValue } from "@/domain/types";
import { Input } from "@/components/ui/input";

type Kind = DateValue["kind"] | "none";

/** Lets the student pick which date form they mean — never forces an exact time. */
export function DateInput({ value, onChange, allowEmpty }: { value?: DateValue; onChange: (d: DateValue | undefined) => void; allowEmpty?: boolean }) {
  const kind: Kind = value?.kind ?? "none";
  const setKind = (k: Kind) => {
    if (k === "none") onChange(undefined);
    else if (k === "exact") onChange({ kind: "exact", iso: new Date().toISOString(), tz: "Asia/Almaty" });
    else if (k === "date") onChange({ kind: "date", date: new Date().toISOString().slice(0, 10) });
    else if (k === "week") onChange({ kind: "week", week: 1 });
    else onChange({ kind: "unknown" });
  };
  return (
    <div className="flex flex-wrap gap-2">
      <select aria-label="Date form" className="h-9 rounded-md border bg-card px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        {allowEmpty && <option value="none">Use source date</option>}
        <option value="exact">Exact date & time</option>
        <option value="date">Date only</option>
        <option value="week">Teaching week</option>
        <option value="unknown">Unknown</option>
      </select>
      {value?.kind === "exact" && (
        <Input
          type="datetime-local"
          aria-label="Date and time"
          className="w-auto"
          value={value.iso.slice(0, 16)}
          onChange={(e) => e.target.value && onChange({ kind: "exact", iso: new Date(e.target.value).toISOString(), tz: value.tz })}
        />
      )}
      {value?.kind === "date" && (
        <Input type="date" aria-label="Date" className="w-auto" value={value.date} onChange={(e) => e.target.value && onChange({ kind: "date", date: e.target.value })} />
      )}
      {value?.kind === "week" && (
        <Input type="number" aria-label="Week" min={1} max={30} className="w-24" value={value.week} onChange={(e) => onChange({ kind: "week", week: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })} />
      )}
    </div>
  );
}
