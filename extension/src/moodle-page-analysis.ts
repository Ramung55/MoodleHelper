/**
 * #20 live page analysis. Runs where a DOM parser exists (the offscreen document,
 * or jsdom in tests), never in the service worker. Input is the fetched envelope
 * and HTML text; output is serializable: the observed access result, discovered
 * activity links, quiz card titles and the registry's collector results. No
 * Document, page body or credential leaves this function.
 */
import {detectObservedMoodleAccess, type MoodleAccessInput, type MoodleAccessResult, type ObservedRoute} from './moodle-access';
import {parseMoodleQuizPage} from './moodle-quizzes';
import {liveRegistry, pageRoute, type Collector, type CollectorRegistry} from './page-refresh';
import type {ScanEnvelope} from './scan-coordinator';
import type {CollectorResult} from '../../frontend/src/domain/types';

export interface AnalysisRequest {
  envelope:Omit<ScanEnvelope,'document'>;
  html:string;
  sourceCourseId:string;
  collectors:Collector[];
  observedAt:string;
  title?:string;
}
export interface AnalysisResult {
  access:MoodleAccessResult;
  links:string[];
  titles:Record<string,string>;
  collected:Partial<Record<Collector,CollectorResult>>;
}
export type Analyzer=(request:AnalysisRequest)=>Promise<AnalysisResult>;

const ORIGIN='https://moodle.sdu.edu.kz';
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value);

export function observedRoute(url:string,sourceCourseId:string):ObservedRoute|undefined {
  const route=pageRoute(url);
  if(!route||!decimal(sourceCourseId))return undefined;
  if(route.kind==='course'&&route.id===sourceCourseId)return {kind:'course',courseId:sourceCourseId};
  if(route.kind==='quiz'&&decimal(route.id))return {kind:'quiz',cmid:route.id,courseId:sourceCourseId};
  return undefined;
}
const unsupportedRoute:MoodleAccessResult={status:'unsupported',retryable:false,reason:'unsupported_route',message:'This page route is not supported.'};

/** Activity links rebuilt from `li.activity.modtype_<type>#module-<cmid>`, never from href. */
export function activityLinks(doc:Document):string[] {
  const links=new Set<string>();
  for(const item of Array.from(doc.querySelectorAll('li.activity[id^="module-"]'))){
    const cmid=/^module-([1-9][0-9]{0,18})$/.exec(item.id)?.[1];
    const types=Array.from(item.classList).map(c=>/^modtype_([a-z][a-z0-9_]{0,31})$/.exec(c)?.[1]).filter((t):t is string=>!!t);
    if(!cmid||types.length!==1)continue;
    links.add(`${ORIGIN}/mod/${types[0]}/view.php?id=${cmid}`);
  }
  return [...links];
}

export async function analyzeMoodlePage(request:AnalysisRequest,options:{registry?:CollectorRegistry;parse?:(html:string)=>Document}={}):Promise<AnalysisResult> {
  const registry=options.registry??liveRegistry();
  const parse=options.parse??((html:string)=>new DOMParser().parseFromString(html,'text/html'));
  const empty={links:[],titles:{},collected:{}};
  const route=observedRoute(request.envelope.requestedUrl,request.sourceCourseId);
  if(!route)return {access:unsupportedRoute,...empty};
  const document=parse(typeof request.html==='string'?request.html:'');
  const input:MoodleAccessInput={...request.envelope,document};
  const access=detectObservedMoodleAccess(input,route);
  if(access.status!=='accessible')return {access,...empty};
  const titles:Record<string,string>={}, collected:Partial<Record<Collector,CollectorResult>>={};
  let links:string[]=[];
  if(route.kind==='course'){
    links=activityLinks(document);
    const cards=parseMoodleQuizPage(input,request.observedAt);
    for(const card of cards.observations)
      if(card.sourceCourseId===route.courseId&&card.title.kind==='known')titles[card.sourceCourseModuleId]=card.title.value;
  }
  for(const collector of request.collectors){
    const adapter=registry[collector];
    if(!adapter||adapter.availability!=='available')continue;
    try {
      const result=await adapter.collect(input,[request.sourceCourseId],request.observedAt,request.title?{title:request.title}:{});
      const foreign=result.kind!=='failed'&&result.kind!=='unavailable'&&(result.observations as {sourceCourseId?:string}[]).some(o=>o.sourceCourseId!==request.sourceCourseId);
      collected[collector]=foreign?{kind:'failed',reasons:['identity_mismatch']}:result;
    } catch {
      collected[collector]={kind:'failed',reasons:['collector_failed']};
    }
  }
  return {access,links,titles,collected};
}
