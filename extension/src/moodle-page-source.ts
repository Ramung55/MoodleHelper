/**
 * #20 live Moodle page source behind the same `start(url) -> {completion,
 * termination, abort}` shape as the synthetic source.
 *
 * - GET only, `credentials: 'include'`, `redirect: 'follow'`, `cache: 'no-store'`;
 *   `response.url` is the final URL. No form posts, sesskey or AJAX.
 * - Only exact `pageRoute()` routes on https://moodle.sdu.edu.kz, never
 *   `pluginfile.php`, resource or URL module pages.
 * - Hard 30 s limit per request through an AbortController. `termination`
 *   resolves only after the fetch settled: the body was read, or the abort or
 *   error was observed. A fetch that never settles keeps the authority occupied.
 * - Reading stops after 1 MiB; non-HTML content is cancelled unread and recorded
 *   as unsupported. Page bodies, cookies and tokens are never stored or logged:
 *   the HTML text goes only to the analyzer (the offscreen document).
 */
import {detectObservedMoodleAccess} from './moodle-access';
import {observedRoute, type AnalysisRequest, type AnalysisResult, type Analyzer} from './moodle-page-analysis';
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

export function createMoodlePageSource(options:{fetcher?:typeof fetch;analyze:Analyzer;now:()=>number}):ScanSource {
  const fetcher:typeof fetch=(input,init)=>(options.fetcher??globalThis.fetch)(input,init);
  return {start(url:string,context?:StartContext):ScanRequest {
    if(!liveRouteAllowed(url)||!context)throw Error('Route not allowed');
    const controller=new AbortController();
    let external=false;
    const timer=setTimeout(()=>controller.abort(),REQUEST_LIMIT_MS);
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
      const request:AnalysisRequest={envelope:input,html:got.html,sourceCourseId:context.sourceCourseId,collectors:context.collectors,observedAt,
        ...(context.title?{title:context.title}:{})};
      const analysis:AnalysisResult=await options.analyze(request);
      return {...base,access:analysis.access,links:analysis.links,titles:analysis.titles,collected:analysis.collected};
    })();
    return {completion,termination,abort(){external=true;controller.abort();}};
  }};
}

export type OffscreenChrome={
  runtime:{getURL?:(path:string)=>string;sendMessage?:(message:unknown,callback:(reply:unknown)=>void)=>void;lastError?:unknown};
  offscreen?:{createDocument:(options:{url:string;reasons:string[];justification:string})=>Promise<void>};
};
/** Worker side of the offscreen document: create it on demand, then ask it to analyze. */
export function offscreenAnalyzer(chrome:OffscreenChrome):Analyzer {
  let ready:Promise<void>|undefined;
  const ensure=()=>{
    if(!chrome.offscreen||!chrome.runtime.sendMessage)return Promise.reject(Error('Offscreen documents are unavailable.'));
    ready??=chrome.offscreen.createDocument({url:chrome.runtime.getURL?chrome.runtime.getURL(OFFSCREEN_PATH):OFFSCREEN_PATH,reasons:['DOM_PARSER'],
      justification:'Parse fetched SDU Moodle pages for the read-only course scan.'})
      // Chrome allows one offscreen document per extension; an existing one is reused.
      .catch((error:unknown)=>{if(!/single offscreen|already/i.test(String((error as Error)?.message??error))){ready=undefined;throw error;}});
    return ready;
  };
  return async request=>{
    await ensure();
    return await new Promise<AnalysisResult>((resolve,reject)=>{
      const timer=setTimeout(()=>{ready=undefined;reject(Error('Analysis timed out.'));},ANALYSIS_TIMEOUT_MS);
      const message:OffscreenMessage={target:OFFSCREEN_TARGET,type:'analyze',request};
      chrome.runtime.sendMessage!(message,reply=>{
        clearTimeout(timer);
        const r=reply as OffscreenReply|undefined;
        if(chrome.runtime.lastError||!r||r.ok!==true){ready=undefined;reject(Error('Analysis failed.'));return;}
        resolve(r.result);
      });
    });
  };
}
