/**
 * #20 live Moodle page source behind the same `start(url) -> {completion,
 * termination, abort}` shape as the synthetic source.
 *
 * - GET only, `credentials: 'include'`, `redirect: 'follow'`, `cache: 'no-store'`;
 *   `response.url` is the final URL. No form posts, sesskey or AJAX. The one
 *   exception is `startDiscoveryRequest` below (#82, owner decision D1).
 * - Only exact `pageRoute()` routes on https://moodle.sdu.edu.kz, never
 *   `pluginfile.php`, resource or URL module pages.
 * - Hard 30 s limit per request through an AbortController. `termination`
 *   resolves only after the fetch settled: the body was read, or the abort or
 *   error was observed. A fetch that never settles keeps the authority occupied.
 * - Reading stops after 1 MiB; non-HTML content is cancelled unread and recorded
 *   as unsupported. Page bodies, cookies and tokens are never stored or logged:
 *   the HTML text goes only to the analyzer (the offscreen document).
 * - #20 AC4: each response is classified here first, from `response.url`, its status,
 *   content type and the `<body>` id and classes of the very text that was read
 *   (`responseAccess`). Only an accessible page is sent to the offscreen analysis, and
 *   that reply can only narrow access, never make a login page accessible.
 */
import {detectObservedMoodleAccess, type MoodleAccessResult} from './moodle-access';
import {observedRoute, responseAccess, type AccessChecker, type AnalysisRequest, type AnalysisResult, type Analyzer} from './moodle-page-analysis';
import {OFFSCREEN_PATH, OFFSCREEN_TARGET, type OffscreenMessage, type OffscreenReply} from './offscreen';
import {pageRoute} from './page-refresh';
import type {ScanEnvelope, ScanRequest, ScanResponse, ScanSource, StartContext} from './scan-coordinator';

export const REQUEST_LIMIT_MS=30_000;
export const MAX_BODY_BYTES=1_048_576;
const ANALYSIS_TIMEOUT_MS=10_000;

/** Exact allowed live routes; resource and URL modules (file downloads) are never requested. */
export function liveRouteAllowed(url:string):boolean {
  const route=pageRoute(url);
  return !!route && !url.includes('#') && !['resource','url'].includes(route.kind) && !/pluginfile\.php/i.test(url);
}
const isHtml=(contentType:string|undefined)=>{
  const mime=(contentType??'').split(';',1)[0]!.trim().toLowerCase();
  return mime==='text/html'||mime==='application/xhtml+xml';
};

async function readCapped(response:Response):Promise<{html:string;bytes:number;truncated:boolean}> {
  const reader=response.body?.getReader();
  if(!reader)return {html:'',bytes:0,truncated:false};
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    bytes+=value.byteLength;
    if(bytes>MAX_BODY_BYTES){await reader.cancel().catch(()=>{});return {html:'',bytes,truncated:true};}
    chunks.push(value);
  }
  const all=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  return {html:new TextDecoder('utf-8').decode(all),bytes,truncated:false};
}

/**
 * #82 course discovery routes (owner decision D1, 2026-11-02). Exactly two more routes:
 * - `GET https://moodle.sdu.edu.kz/my/courses.php`;
 * - one `POST https://moodle.sdu.edu.kz/lib/ajax/service.php?sesskey=<alphanumeric>&info=<METHOD>`
 *   with a `Content-Type: application/json` body holding exactly one call
 *   `{index: 0, methodname: METHOD, args: {offset, limit, classification: "inprogress", sort: "fullname"}}`.
 * Any other request, including any other POST, is refused before `fetch` is called. The
 * sesskey is only in the URL the caller built for this one request; it is never kept here.
 * Same rules as the scan: credentials included, redirects followed, no cache, 30 s limit,
 * 1 MiB body cap, and `termination` resolves only after the fetch settled.
 */
export const MY_COURSES_URL='https://moodle.sdu.edu.kz/my/courses.php';
export const ENROLLED_METHOD='core_course_get_enrolled_courses_by_timeline_classification';
const SERVICE_PATH='/lib/ajax/service.php';
export type DiscoveryRequest={method:'GET';url:string}|{method:'POST';url:string;body:string};
export type DiscoveryResponse={networkFailure:true}|{networkFailure:false;status:number;finalUrl:string;contentType?:string;retryAfter?:string;text:string;bytes:number;truncated:boolean};
export interface DiscoveryRequestHandle {completion:Promise<DiscoveryResponse>;termination:Promise<boolean>;abort:()=>void}
type Fields={method?:unknown;url?:unknown;body?:unknown;index?:unknown;methodname?:unknown;args?:unknown;offset?:unknown;limit?:unknown;classification?:unknown;sort?:unknown};
const plainObject=(value:unknown):value is Fields=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value:object,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
/** The service URL for one enrolled-courses call; the caller holds the sesskey. */
export function enrolledCoursesUrl(sesskey:string):string {
  return `https://moodle.sdu.edu.kz${SERVICE_PATH}?sesskey=${sesskey}&info=${ENROLLED_METHOD}`;
}
export function discoveryRequestAllowed(request:unknown):request is DiscoveryRequest {
  try {
    if(!plainObject(request)||typeof request.url!=='string')return false;
    if(request.method==='GET')return exactKeys(request,['method','url'])&&request.url===MY_COURSES_URL;
    if(request.method!=='POST'||!exactKeys(request,['method','url','body'])||typeof request.body!=='string')return false;
    const sesskey=/^https:\/\/moodle\.sdu\.edu\.kz\/lib\/ajax\/service\.php\?sesskey=([A-Za-z0-9]{1,64})&info=([a-z_]+)$/.exec(request.url);
    if(!sesskey||request.url!==enrolledCoursesUrl(sesskey[1]!))return false;
    const url=new URL(request.url);
    if(url.origin!=='https://moodle.sdu.edu.kz'||url.pathname!==SERVICE_PATH||[...url.searchParams.keys()].join()!=='sesskey,info')return false;
    const calls:unknown=JSON.parse(request.body);
    if(!Array.isArray(calls)||calls.length!==1)return false;
    const call=calls[0];
    if(!plainObject(call)||!exactKeys(call,['index','methodname','args'])||call.index!==0||call.methodname!==ENROLLED_METHOD)return false;
    const args=call.args;
    return plainObject(args)&&exactKeys(args,['offset','limit','classification','sort'])&&
      Number.isSafeInteger(args.offset)&&(args.offset as number)>=0&&Number.isSafeInteger(args.limit)&&(args.limit as number)>=1&&(args.limit as number)<=100&&
      args.classification==='inprogress'&&args.sort==='fullname';
  } catch {return false;}
}
const isJson=(contentType:string|undefined)=>(contentType??'').split(';',1)[0]!.trim().toLowerCase()==='application/json';

export function startDiscoveryRequest(request:DiscoveryRequest,options:{fetcher?:typeof fetch;requestLimitMs?:number}={}):DiscoveryRequestHandle {
  // Refused before any fetch: the GET-only rule holds for everything but the D1 call.
  if(!discoveryRequestAllowed(request))throw Error('Route not allowed');
  const limit=Math.min(options.requestLimitMs??REQUEST_LIMIT_MS,REQUEST_LIMIT_MS);
  const fetcher=options.fetcher??globalThis.fetch;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),limit);
  let settle!:(value:boolean)=>void;
  const termination=new Promise<boolean>(resolve=>settle=resolve);
  const init:RequestInit=request.method==='GET'
    ?{method:'GET',credentials:'include',redirect:'follow',cache:'no-store',signal:controller.signal}
    :{method:'POST',credentials:'include',redirect:'follow',cache:'no-store',signal:controller.signal,
      headers:{Accept:'application/json','Content-Type':'application/json'},body:request.body};
  const completion=(async():Promise<DiscoveryResponse>=>{
    try {
      const response=await fetcher(request.url,init);
      const contentType=response.headers.get('content-type')??undefined;
      const retryAfter=response.headers.get('retry-after')??undefined;
      let body={html:'',bytes:0,truncated:false};
      // HTML for the shell page and signed-out pages; JSON only for the service call.
      if(isHtml(contentType)||(request.method==='POST'&&isJson(contentType)))body=await readCapped(response);
      else await response.body?.cancel().catch(()=>{});
      return {networkFailure:false,status:response.status,finalUrl:(response.url||request.url).split('#')[0]!,
        ...(contentType!==undefined?{contentType}:{}),...(retryAfter!==undefined?{retryAfter}:{}),text:body.html,bytes:body.bytes,truncated:body.truncated};
    } catch {
      return {networkFailure:true};
    } finally {
      clearTimeout(timer);
      // The fetch, its body read or its abort has settled: only now may the gate open.
      settle(true);
    }
  })();
  return {completion,termination,abort(){controller.abort();}};
}

export function createMoodlePageSource(options:{fetcher?:typeof fetch;analyze:Analyzer;now:()=>number;requestLimitMs?:number}):ScanSource {
  // A shorter limit is only a test seam; the hard limit is never exceeded.
  const limit=Math.min(options.requestLimitMs??REQUEST_LIMIT_MS,REQUEST_LIMIT_MS);
  const fetcher:typeof fetch=(input,init)=>(options.fetcher??globalThis.fetch)(input,init);
  return {start(url:string,context?:StartContext):ScanRequest {
    if(!liveRouteAllowed(url)||!context)throw Error('Route not allowed');
    const controller=new AbortController();
    let external=false;
    const timer=setTimeout(()=>controller.abort(),limit);
    let settle!:(value:boolean)=>void;
    const termination=new Promise<boolean>(resolve=>settle=resolve);
    const fetched=(async()=>{
      try {
        const response=await fetcher(url,{method:'GET',credentials:'include',redirect:'follow',cache:'no-store',signal:controller.signal});
        const contentType=response.headers.get('content-type')??undefined;
        const retryAfter=response.headers.get('retry-after')??undefined;
        let body={html:'',bytes:0,truncated:false};
        if(isHtml(contentType))body=await readCapped(response);
        else await response.body?.cancel().catch(()=>{});
        return {status:response.status,finalUrl:(response.url||url).split('#')[0]!,contentType,retryAfter,...body};
      } finally {
        clearTimeout(timer);
        // The fetch, its body read or its abort has settled: only now may the gate open.
        settle(true);
      }
    })();
    const completion=(async():Promise<ScanResponse>=>{
      const observedAt=new Date(options.now()).toISOString();
      let got:Awaited<typeof fetched>;
      try {got=await fetched;}
      catch {
        if(external)throw Error('Request aborted');
        // Time limit or network failure: a retryable network failure.
        const input={requestedUrl:url,finalUrl:url,httpStatus:0,networkFailure:true};
        const route=observedRoute(url,context.sourceCourseId);
        return {input,links:[],sourceCourseId:context.sourceCourseId,bytes:0,observedAt,
          ...(route?{access:detectObservedMoodleAccess(input,route)}:{})};
      }
      if(external)throw Error('Request aborted');
      const input:ScanEnvelope={requestedUrl:url,finalUrl:got.finalUrl,httpStatus:got.status,networkFailure:false,...(got.contentType!==undefined?{contentType:got.contentType}:{})};
      const base={input,sourceCourseId:context.sourceCourseId,bytes:got.bytes,observedAt,...(got.retryAfter!==undefined?{retryAfter:got.retryAfter}:{})};
      const route=observedRoute(url,context.sourceCourseId);
      if(!got.html||got.truncated||!route)
        return {...base,links:[],...(route?{access:detectObservedMoodleAccess(input,route)}:{})};
      // #20 AC4: classify this response here, from its own final URL, status and <body> id
      // and classes, before any analysis. A login page (or any page that is not accessible)
      // is never sent to the offscreen document, so no analysis reply can make it accessible.
      const own=responseAccess(input,got.html,route);
      if(own.status!=='accessible')return {...base,links:[],access:own};
      const request:AnalysisRequest={envelope:input,html:got.html,sourceCourseId:context.sourceCourseId,collectors:context.collectors,observedAt,
        ...(context.title?{title:context.title}:{})};
      const analysis:AnalysisResult=await options.analyze(request);
      if(!analysis?.access)throw Error('Analysis failed.');
      // The analysis may only narrow access: anything but its own accessible verdict wins.
      if(analysis.access.status!=='accessible')return {...base,links:[],access:analysis.access};
      return {...base,access:own,links:analysis.links,titles:analysis.titles,collected:analysis.collected};
    })();
    return {completion,termination,abort(){external=true;controller.abort();}};
  }};
}

export type OffscreenChrome={
  runtime:{getURL?:(path:string)=>string;sendMessage?:(message:unknown,callback:(reply:unknown)=>void)=>void;lastError?:unknown};
  offscreen?:{createDocument:(options:{url:string;reasons:string[];justification:string})=>Promise<void>};
};
/** Worker side of the offscreen document: create it on demand, then ask it to analyze or check access. */
export function createOffscreenClient(chrome:OffscreenChrome):{analyze:Analyzer;access:AccessChecker} {
  let ready:Promise<void>|undefined;
  const ensure=()=>{
    if(!chrome.offscreen||!chrome.runtime.sendMessage)return Promise.reject(Error('Offscreen documents are unavailable.'));
    ready??=chrome.offscreen.createDocument({url:chrome.runtime.getURL?chrome.runtime.getURL(OFFSCREEN_PATH):OFFSCREEN_PATH,reasons:['DOM_PARSER'],
      justification:'Parse fetched SDU Moodle pages for the read-only course scan.'})
      // Chrome allows one offscreen document per extension; an existing one is reused.
      .catch((error:unknown)=>{if(!/single offscreen|already/i.test(String((error as Error)?.message??error))){ready=undefined;throw error;}});
    return ready;
  };
  async function send<T>(message:OffscreenMessage):Promise<T> {
    await ensure();
    return await new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{ready=undefined;reject(Error('Analysis timed out.'));},ANALYSIS_TIMEOUT_MS);
      chrome.runtime.sendMessage!(message,reply=>{
        clearTimeout(timer);
        const r=reply as OffscreenReply|undefined;
        if(chrome.runtime.lastError||!r||r.ok!==true){ready=undefined;reject(Error('Analysis failed.'));return;}
        resolve(r.result as T);
      });
    });
  }
  return {
    analyze:request=>send<AnalysisResult>({target:OFFSCREEN_TARGET,type:'analyze',request}),
    access:request=>send<MoodleAccessResult>({target:OFFSCREEN_TARGET,type:'access',request}),
  };
}
export function offscreenAnalyzer(chrome:OffscreenChrome):Analyzer {
  return createOffscreenClient(chrome).analyze;
}
