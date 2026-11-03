import { useEffect, useState } from "react";
import type { LocalEvidenceRef } from "@/domain/types";
import { readLocalEvidence, type LocalEvidenceRecord } from "@/services/local-evidence";
/** Browser reference lookup; never labels an empty metadata field original evidence. */
export function LocalEvidenceView({ reference }: { reference: LocalEvidenceRef }) {
  const [value, setValue] = useState<{ record?: LocalEvidenceRecord; sourceAvailable: boolean }>(), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let alive = true; setValue(undefined); setError("");
    void readLocalEvidence(reference, controller.signal).then(result => { if (alive && !controller.signal.aborted) setValue(result); }).catch(failure => { if (alive && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Stored local evidence is unavailable."); });
    return () => { alive = false; controller.abort(); };
  }, [reference.datasetId, reference.courseId, reference.digest, reference.mentionId, reference.pipelineVersion]);
  if (error) return <p className="text-sm text-muted-foreground">Stored original evidence unavailable: {error}</p>;
  if (!value) return <p className="text-xs">Looking up original evidence in this browser…</p>;
  if (!value.record) return <p className="text-sm text-muted-foreground">Original evidence is not stored in this browser/profile for this dataset. Backend metadata remains available; reselect the original document to inspect its source.</p>;
  const original = value.record.original;
  return <div className="mt-2 space-y-1 rounded border p-2 text-sm"><p className="font-medium">Stored original local evidence</p><p className="text-xs">{value.sourceAvailable ? "Original document is available locally." : "Original document is unavailable; the retained evidence below remains available."}</p><blockquote className="whitespace-pre-wrap border-l-2 pl-2">{original.mention.excerpt}</blockquote><p>Original proposed title: {original.mention.title}</p><p className="whitespace-pre-wrap">Original schedule wording: {original.mention.rawScheduleText}</p><details><summary>Original proposals, location and routing audit</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({ dates: original.dates, week: original.week, location: original.mention.location, pipelineVersion: value.record.pipelineVersion, audit: value.record.audit }, null, 2)}</pre></details></div>;
}
