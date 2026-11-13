/**
 * #20 live page analysis. Runs where a DOM parser exists (the offscreen document,
 * or jsdom in tests), never in the service worker. Input is the fetched envelope
 * and HTML text; output is serializable: the observed access result, discovered
 * activity links, quiz card titles and the registry's collector results. No
 * Document, page body or credential leaves this function.
 */
import {detectObservedMoodleAccess, type MoodleAccessInput, type MoodleAccessResult, type ObservedRoute} from './moodle-access';
import {parseMoodleQuizPage} from './moodle-quizzes';
import {UPCOMING_CALENDAR_URL} from './moodle-calendar';
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
  /** #95 calendar visit: the tracked courses whose events are kept; default [sourceCourseId]. */
  selection?:string[];
}
export interface AnalysisResult {
  access:MoodleAccessResult;
  links:string[];
  titles:Record<string,string>;
  collected:Partial<Record<Collector,CollectorResult>>;
}
export type Analyzer=(request:AnalysisRequest)=>Promise<AnalysisResult>;
/**
 * #82 reduced access check. The worker sends only the envelope (URLs without any
 * sesskey), the status, the content type and the `<body>` id and classes, never
 * the page text: the `/my/courses.php` shell holds the session's sesskey.
 */
export interface AccessRequest {
  envelope:Omit<ScanEnvelope,'document'>;
  body:{id:string;classes:string[]};
  route:'my-courses'|'service';
}
export type AccessChecker=(request:AccessRequest)=>Promise<MoodleAccessResult>;
const TOKEN=/^[A-Za-z0-9_-]{1,128}$/;
/** The `<body>` id and classes of an HTML text; nothing else of the page is kept. */
export function reducedBody(html:string,limit=64):AccessRequest['body'] {
  const tag=/<body\b([^>]*)>/i.exec(html)?.[1]??'';
  const attribute=(name:string)=>new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i').exec(tag);
  const id=attribute('id'), classes=attribute('class');
  const idValue=id?.[1]??id?.[2]??'';
  return {id:TOKEN.test(idValue)?idValue:'',classes:(classes?.[1]??classes?.[2]??'').split(/\s+/).filter(c=>TOKEN.test(c)).slice(0,limit)};
}
/** #93: only a canonical positive decimal counts as a Moodle user id. */
export const MOODLE_USER_ID=/^[1-9][0-9]{0,18}$/;
// #93 (compatibility report Addenda 7, 8): the one `"userId":<number>` inside the inline `M.cfg = {...}`, which may hold flat objects such as `"homeurl":{}`.
const M_CFG_USER_ID=/M\.cfg\s*=\s*\{(?:[^{}]|\{[^{}]*\})*?"userId"\s*:\s*(-?[0-9]+)\s*[,}]/;
/**
 * #93: the signed-in user id from the text of a Moodle page already fetched, or undefined.
 * A missing or non-canonical value (the signed-out login page shows a guest value) counts as not read.
 */
export function moodleUserId(html:string):string|undefined {
  const value=M_CFG_USER_ID.exec(html)?.[1];
  return value!==undefined&&MOODLE_USER_ID.test(value)?value:undefined;
}
/**
 * #20 AC4 worker-side check of the very response that was read: the observed access check
 * on its final URL (`response.url`), status, content type and `<body>` id and classes, with
 * no DOM (the service worker has none; the check reads nothing else of the document). The
 * scan uses it before and independently of the offscreen analysis, like #82 discovery and
 * the #46 probe do: a login page is `signed_out` here whatever an analysis reply says.
 */
export function responseAccess(envelope:Omit<ScanEnvelope,'document'>,html:string,route:ObservedRoute):MoodleAccessResult {
  const body=reducedBody(html,512), classes=new Set(body.classes);
  const document={body:{id:body.id,classList:{contains:(name:string)=>classes.has(name)}}} as unknown as Document;
  return detectObservedMoodleAccess({...envelope,document},route);
}
/** Runs where a DOM exists (the offscreen document): #20's observed check on a body-only document. */
export function checkMoodleAccess(request:AccessRequest,options:{parse?:(html:string)=>Document}={}):MoodleAccessResult {
  const parse=options.parse??((html:string)=>new DOMParser().parseFromString(html,'text/html'));
  const document=parse('<!doctype html><html><head></head><body></body></html>');
  const body=request?.body;
  if(body&&typeof body.id==='string'&&TOKEN.test(body.id))document.body.id=body.id;
  if(body&&Array.isArray(body.classes))for(const c of body.classes.slice(0,64))if(typeof c==='string'&&TOKEN.test(c))document.body.classList.add(c);
  const route:ObservedRoute=request?.route==='my-courses'?{kind:'my-courses'}:{kind:'service'};
  return detectObservedMoodleAccess({...request?.envelope,document} as MoodleAccessInput,route);
}

const ORIGIN='https://moodle.sdu.edu.kz';
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value);

export function observedRoute(url:string,sourceCourseId:string):ObservedRoute|undefined {
  const route=pageRoute(url);
  if(!route||!decimal(sourceCourseId))return undefined;
  if(route.kind==='course'&&route.id===sourceCourseId)return {kind:'course',courseId:sourceCourseId};
  if(route.kind==='quiz'&&decimal(route.id))return {kind:'quiz',cmid:route.id,courseId:sourceCourseId};
  if(route.kind==='assign'&&decimal(route.id))return {kind:'assign',cmid:route.id,courseId:sourceCourseId};
  // #83: only the upcoming view was observed (compatibility report row 8).
  if(route.kind==='calendar'&&url===UPCOMING_CALENDAR_URL)return {kind:'calendar-upcoming'};
  return undefined;
}
/**
 * #83 assignment card titles from the course page: `li.activity.modtype_assign#module-<cmid>`
 * with exactly one `.instancename`, its `.accesshide` type label removed. The assignment
 * page `h2` was not recorded by #3, so this card title backs the assignment title.
 */
export function assignmentCardTitles(doc:Document):Record<string,string> {
  const titles:Record<string,string>={};
  for(const card of Array.from(doc.querySelectorAll('li.activity.modtype_assign[id^="module-"]'))){
    const cmid=/^module-([1-9][0-9]{0,18})$/.exec(card.id)?.[1];
    const names=card.querySelectorAll('.instancename');
    if(!cmid||names.length!==1||Object.hasOwn(titles,cmid))continue;
    const name=names[0]!.cloneNode(true) as Element;
    name.querySelectorAll('.accesshide').forEach(n=>n.remove());
    const title=(name.textContent??'').replace(/\s+/gu,' ').trim();
    if(title)titles[cmid]=title;
  }
  return titles;
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
    for(const [cmid,title] of Object.entries(assignmentCardTitles(document)))if(!Object.hasOwn(titles,cmid))titles[cmid]=title;
  }
  for(const collector of request.collectors){
    const adapter=registry[collector];
    if(!adapter||adapter.availability!=='available')continue;
    try {
      const selection=Array.isArray(request.selection)&&request.selection.length?request.selection:[request.sourceCourseId];
      const result=await adapter.collect(input,selection,request.observedAt,request.title?{title:request.title}:{});
      const foreign=result.kind!=='failed'&&result.kind!=='unavailable'&&(result.observations as {sourceCourseId?:string}[]).some(o=>!selection.includes(o.sourceCourseId!));
      collected[collector]=foreign?{kind:'failed',reasons:['identity_mismatch']}:result;
    } catch {
      collected[collector]={kind:'failed',reasons:['collector_failed']};
    }
  }
  return {access,links,titles,collected};
}
