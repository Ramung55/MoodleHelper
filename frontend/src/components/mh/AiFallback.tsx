import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { AssessmentMention } from "@/domain/assessment-mentions";
import type { Snapshot } from "@/domain/types";
import type { AiContextValue } from "@/services/ai-gateway";
import { AI_CLIENT_TIMEOUT_MS, UNAVAILABLE_COPY, classifyAiFailure, freezePreview, loadAiAvailability, routeAiRecords, selectionProblem, sendFrozen, validateAiResponse, type AiOutcome, type AvailableAi, type FrozenPreview, type ValidatedAi } from "@/services/ai-fallback";
import { currentDataset, type LocalAssociation } from "@/services/local-documents";
import { HttpAdapter } from "@/services/http-adapter";

type Deps = { loadAvailability?: typeof loadAiAvailability; send?: typeof sendFrozen; route?: typeof routeAiRecords; dataset?: () => Promise<string | undefined> };

/** Optional, explicit, per-request consent. Never opens itself and never preselects text. */
export function AiFallback({ document: association, mentions, context, commitRoute, deps = {} }: { document: LocalAssociation; mentions: AssessmentMention[]; context?: AiContextValue; commitRoute?: (work: () => Promise<Snapshot>) => Promise<boolean>; deps?: Deps }) {
  const dataset = deps.dataset ?? (() => currentDataset());
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AvailableAi | null | undefined>();
  const [epoch, setEpoch] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [includeContext, setIncludeContext] = useState(false);
  const [preview, setPreview] = useState<FrozenPreview>();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<AiOutcome>();
  const [result, setResult] = useState<ValidatedAi>();
  const controller = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const userCancelled = useRef(false);
  const contextKey = JSON.stringify(context ?? {}), mentionKey = mentions.map(m => m.id).join("|");
  const invalidate = (message = "") => { setPreview(undefined); setResult(undefined); setNote(message); };
  // Any source/context revision invalidates consent; unmount fences late results.
  useEffect(() => { if (preview) invalidate("The selected text or context changed. Review a new preview before sending."); setSelected(ids => ids.filter(id => mentions.some(m => m.id === id))); }, [contextKey, mentionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => { if (!pending) return; const start = Date.now(); const timer = setInterval(() => setElapsed(Math.min(30, Math.floor((Date.now() - start) / 1000))), 500); return () => clearInterval(timer); }, [pending]);

  const start = async () => {
    const attempt = ++generation.current;
    setOpen(true); setInfo(undefined); setOutcome(undefined); invalidate();
    const [loaded, current] = await Promise.all([(deps.loadAvailability ?? loadAiAvailability)(), dataset()]);
    if (attempt !== generation.current) return;
    setEpoch(current); setInfo(loaded.available && current === association.datasetId ? loaded : null);
  };
  const toggle = (id: string) => { invalidate(preview ? "Selection changed. Review a new preview before sending." : ""); setSelected(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]); };
  const review = async () => {
    if (!info || !epoch) return;
    const attempt = ++generation.current;
    try {
      if (await dataset() !== epoch) throw new Error("The local dataset changed since selection started. Close and select again.");
      const chosen = mentions.filter(m => selected.includes(m.id));
      const frozen = await freezePreview({ association, datasetId: epoch, info, mentions: chosen, context: includeContext ? context : undefined });
      if (attempt === generation.current) { setPreview(frozen); setNote(""); setOutcome(undefined); }
    } catch (error) { if (attempt === generation.current) setNote(error instanceof Error ? error.message : "Could not prepare the preview."); }
  };
  const send = async (frozen: FrozenPreview) => {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort; userCancelled.current = false;
    const attempt = ++generation.current;
    setPending(true); setElapsed(0); setOutcome(undefined); setResult(undefined);
    try {
      const response = await (deps.send ?? sendFrozen)(frozen, abort.signal, { dataset });
      if (attempt !== generation.current || abort.signal.aborted) return;
      const validated = await validateAiResponse(frozen, response);
      if (attempt === generation.current) setResult(validated);
    } catch (error) {
      if (attempt === generation.current) setOutcome(classifyAiFailure(error, userCancelled.current));
    } finally { if (attempt === generation.current) { controller.current = undefined; setPending(false); } }
  };
  const cancel = () => { userCancelled.current = true; controller.current?.abort(); };
  const route = async () => {
    if (!preview || !result?.records.length || !commitRoute || controller.current) return;
    const abort = new AbortController(); controller.current = abort; const attempt = ++generation.current; setPending(true);
    try {
      const ok = await commitRoute(async () => (await (deps.route ?? routeAiRecords)(preview, result.records, abort.signal, new HttpAdapter(), dataset)).snapshot);
      if (attempt === generation.current) setNote(ok ? `${result.records.length} AI proposals sent to review. None was confirmed; each needs your decision.` : "Routing was not confirmed. AI evidence remains stored locally; retry routing to reconcile.");
    } catch (error) { if (attempt === generation.current) setNote(`Routing failed: ${error instanceof Error ? error.message : "retry"}. Local data is unchanged.`); }
    finally { if (attempt === generation.current) { controller.current = undefined; setPending(false); } }
  };
  const close = () => { generation.current++; controller.current?.abort(); controller.current = undefined; setPending(false); setOpen(false); setPreview(undefined); setResult(undefined); setOutcome(undefined); setNote(""); setSelected([]); };

  if (!open) return <div className="rounded border p-2 text-xs"><p>Optional AI help can suggest proposals for unresolved excerpts you choose. Nothing is sent unless you review a preview and press Send.</p><Button size="sm" variant="outline" onClick={() => void start()}>Optional AI help</Button></div>;
  return <section aria-label="Optional AI help" className="space-y-2 rounded border p-2 text-xs">
    <h4 className="font-semibold">Optional AI help</h4>
    {info === undefined && <p role="status">Checking AI availability locally…</p>}
    {info === null && <div className="space-y-2"><p role="status">{UNAVAILABLE_COPY}. No text was sent.</p><Button size="sm" variant="outline" onClick={close}>Continue locally</Button></div>}
    {info && !preview && <fieldset className="space-y-1"><legend className="font-medium">Select excerpts to send (none preselected; up to 8, 2,000 bytes each)</legend>
      {mentions.map(m => { const problem = selectionProblem(m); return <label key={m.id} className="flex gap-2"><input type="checkbox" aria-label={`Select excerpt ${m.title}`} disabled={!!problem} checked={selected.includes(m.id)} onChange={() => toggle(m.id)} /><span><span className="font-medium">{m.title}</span> · <span className="whitespace-pre-wrap">{m.excerpt}</span>{problem && <span className="block">{problem}</span>}</span></label>; })}
      {context && Object.keys(context).length > 0 && <label className="flex gap-2"><input type="checkbox" aria-label="Include explicit document context" checked={includeContext} onChange={() => { invalidate(); setIncludeContext(v => !v); }} />Include explicit document context: {contextKey}</label>}
      <div className="flex gap-2"><Button size="sm" variant="outline" disabled={!selected.length} onClick={() => void review()}>Review what will be sent</Button><Button size="sm" variant="ghost" onClick={close}>Cancel</Button></div>
    </fieldset>}
    {note && <p role="status">{note}</p>}
    {preview && <div className="space-y-2" aria-label="AI send preview">
      <p><strong>Destination:</strong> {preview.policy.provider} (destination “{preview.policy.destination}”, mode {preview.policy.mode})</p>
      <p><strong>Retention:</strong> {preview.policy.retention}</p>
      <p><strong>Policy:</strong> {preview.policy.policyVersion} · cost cap ${preview.policy.limits.monthlyCapUsd}/month, reserve ${preview.policy.limits.perRequestReserveUsd}/request{preview.policy.limits.simulatedCost ? " (simulated)" : ""} · timeout 30 s</p>
      <p>These excerpts may contain private information. They are sent exactly as shown, without automatic redaction. Files, Moodle session data and cloud-sync records are never sent.</p>
      <ol className="space-y-1">{preview.excerpts.map(e => <li key={e.id} className="rounded border p-1"><p>{e.label} · source {e.locationId}</p><pre className="whitespace-pre-wrap break-all">{e.text}</pre></li>)}</ol>
      {preview.context && <p>Context: <code>{JSON.stringify(preview.context)}</code></p>}
      <p>Request {preview.requestId} · {preview.bodyBytes} bytes · payload SHA-256 {preview.payloadDigest}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => void send(preview)}>Send</Button>
        <Button size="sm" variant="ghost" onClick={pending ? cancel : close}>{pending ? "Cancel request" : "Cancel"}</Button>
      </div>
      {pending && <><p role="status">Waiting for the gateway… {elapsed} s of {AI_CLIENT_TIMEOUT_MS / 1000} s</p><Progress value={elapsed / 30 * 100} aria-label="AI request time elapsed" /></>}
      {outcome && <div className="space-y-1"><p role="alert">{outcome.message}</p><p>Last outcome: {outcome.kind}{outcome.maybeReceived ? " · request possibly received" : ""}</p>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => void send(preview)}>Retry same request</Button><Button size="sm" variant="ghost" onClick={close}>Continue local review</Button></div></div>}
      {result && <div className="space-y-1"><p>{result.records.length} AI proposals validated against your selected excerpts{result.rejected.length ? `; ${result.rejected.length} rejected (unsupported evidence)` : ""}. All are unconfirmed and require review.</p>
        {result.records.map(r => <p key={r.mentionId}>{r.proposal.title} · {r.proposal.type} · {r.proposal.date.kind === "date" ? r.proposal.date.date : r.proposal.date.kind === "week" ? `week ${r.proposal.date.week}` : "no date"} · {r.original.mention.reasons.filter(x => x.startsWith("AI")).join(" ")}</p>)}
        {commitRoute && result.records.length > 0 && <Button size="sm" variant="outline" disabled={pending} onClick={() => void route()}>Send AI proposals to review</Button>}
      </div>}
    </div>}
  </section>;
}
