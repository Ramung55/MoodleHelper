/** Only a trusted caller may inject an example; queue jobs never create evidence. */
export type FullSyncAttestation = {
  completedAt: string;
  courseIds: string[];
  provenance: 'synthetic-example';
};

function strictInstant(value:string):number | undefined {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!m) return;
  const [,year,month,day,hour,minute,second,,offset]=m;
  const y=Number(year), mo=Number(month), d=Number(day), h=Number(hour), mi=Number(minute), s=Number(second);
  if(mo<1||mo>12||d<1||h>23||mi>59||s>59 || offset==='-00:00' || (offset!=='Z' && (Number(offset!.slice(1,3))>23 || Number(offset!.slice(4,6))>59))) return;
  const date=new Date(0); date.setUTCFullYear(y,mo-1,d); date.setUTCHours(h,mi,s,0);
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==mo-1||date.getUTCDate()!==d) return;
  const time=Date.parse(value); return Number.isFinite(time)?time:undefined;
}

function format(instant:number, timezone:string):string {
  let zone=timezone;
  try { new Intl.DateTimeFormat('en-GB',{timeZone:zone}).format(instant); } catch { zone='UTC'; }
  const formatted=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(instant);
  return `${formatted} (${zone})`;
}

/** A valid instant in the configured timezone (UTC fallback), or undefined. */
export function formatInstant(value:unknown, timezone='UTC'):string | undefined {
  const instant=typeof value==='string' ? strictInstant(value) : undefined;
  return instant===undefined ? undefined : format(instant,timezone);
}

export const NO_FULL_SYNC='No successful full sync yet.';

export function fullSyncFreshness(selected:string[], evidence?:FullSyncAttestation, timezone='UTC'):string {
  const instant=typeof evidence?.completedAt==='string' ? strictInstant(evidence.completedAt) : undefined;
  if (!evidence || evidence.provenance !== 'synthetic-example' ||
      instant===undefined ||
      !Array.isArray(evidence.courseIds) || !selected.length ||
      selected.some(id=>typeof id!=='string'||!id.trim()) ||
      evidence.courseIds.some(id=>typeof id!=='string'||!id.trim()) ||
      new Set(evidence.courseIds).size!==evidence.courseIds.length ||
      new Set(selected).size!==selected.length || evidence.courseIds.length!==selected.length ||
      [...evidence.courseIds].sort().some((id,i)=>id!==[...selected].sort()[i])) {
    return NO_FULL_SYNC;
  }
  return `Synthetic example — successful full sync: ${format(instant,timezone)}`;
}

/** The parts of a Snapshot the freshness display reads. */
export type FreshnessSnapshot = {
  courses:{id:string; name?:string; discovery?:{sourceCourseId?:string} | undefined}[];
  sync:{courseId:string; status:string; coverage:string; lastSuccessAt?:string | undefined; lastAttemptAt?:string | undefined}[];
  settings:{trackedCourseIds:string[]; timezone?:string | undefined};
  collection?:{refreshes:{sourceCourseIds:string[]; observedAt:string; scope:string; outcome:string; evidenceMode:string}[]} | undefined;
};

export type Freshness = {
  /** `Successful full sync: …`, the synthetic example, or `No successful full sync yet.` */
  fullSync:string;
  /** Short Overview card value: the full-sync time, `Example` or `Never`. */
  value:string;
  /** The latest individual-page refresh of a selected course; never a full-sync time. */
  pageRefresh:string;
  /** Per-course completed-scan, failed-attempt or (demo) saved-timestamp lines. */
  courses:string[];
};

/**
 * One rule for the Overview card, the dashboard panel and the popup (#21 AC2).
 * A real full sync needs the real (non-demo) dataset and a valid `coverage: full`
 * entry for every selected course; it shows the earliest `lastSuccessAt`. Page
 * receipts, mock runs and partial scans never produce it.
 */
export function syncFreshness(snapshot:FreshnessSnapshot, realData:boolean, evidence?:FullSyncAttestation):Freshness {
  const selected=snapshot.settings.trackedCourseIds, timezone=snapshot.settings.timezone ?? 'UTC';
  const name=(id:string)=>snapshot.courses.find(c=>c.id===id)?.name ?? id;
  const selectedSources=new Set(snapshot.courses.filter(c=>selected.includes(c.id)).map(c=>c.discovery?.sourceCourseId).filter(Boolean));
  const receipt=snapshot.collection?.refreshes.filter(r=>r.sourceCourseIds.some(id=>selectedSources.has(id))).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
  const pageRefresh=receipt ? `Latest page refresh: ${receipt.observedAt} · ${receipt.scope} · ${receipt.outcome} · ${receipt.evidenceMode} evidence` : 'No individual-page refresh recorded.';
  if(!realData) {
    const fullSync=fullSyncFreshness(selected,evidence,timezone);
    return {fullSync, value:fullSync===NO_FULL_SYNC?'Never':'Example', pageRefresh,
      courses:snapshot.sync.filter(x=>x.lastSuccessAt).map(x=>`Saved course timestamp (sample/demo values are fictional): ${x.courseId} · ${x.lastSuccessAt}`)};
  }
  const entries=selected.map(id=>snapshot.sync.find(x=>x.courseId===id));
  const successes=entries.map(x=>x?.coverage==='full' && typeof x.lastSuccessAt==='string' ? strictInstant(x.lastSuccessAt) : undefined);
  const complete=selected.length>0 && new Set(selected).size===selected.length && successes.every(t=>t!==undefined);
  const earliest=complete ? format(Math.min(...successes as number[]),timezone) : undefined;
  const courses:string[]=[];
  for(const entry of entries) {
    if(!entry) continue;
    const completed=formatInstant(entry.lastSuccessAt,timezone), attempted=formatInstant(entry.lastAttemptAt,timezone);
    if(completed && entry.coverage!=='full') courses.push(`Last completed scan (partial coverage): ${name(entry.courseId)} · ${completed}`);
    if(attempted && entry.status==='failed') courses.push(`Last failed scan attempt: ${name(entry.courseId)} · ${attempted}`);
  }
  return {fullSync:earliest?`Successful full sync: ${earliest}`:NO_FULL_SYNC, value:earliest ?? 'Never', pageRefresh, courses};
}
