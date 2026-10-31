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
    return 'No successful full sync yet.';
  }
  let zone=timezone;
  try { new Intl.DateTimeFormat('en-GB',{timeZone:zone}).format(instant); } catch { zone='UTC'; }
  const formatted=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(instant);
  return `Synthetic example — successful full sync: ${formatted} (${zone})`;
}
