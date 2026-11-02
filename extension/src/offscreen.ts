/**
 * #20 offscreen document (reason DOM_PARSER). An MV3 service worker has no
 * DOMParser, so the scan worker sends this page the fetched envelope and HTML
 * text; it runs the observed access check, link discovery and the live
 * registry's collectors, and replies with serializable results only. It makes
 * no network request and keeps nothing. The worker side is `offscreenAnalyzer`
 * in moodle-page-source.ts.
 */
import {analyzeMoodlePage, type AnalysisRequest, type AnalysisResult, type Analyzer} from './moodle-page-analysis';

export const OFFSCREEN_TARGET='moodle-helper-offscreen';
export const OFFSCREEN_PATH='offscreen.html';
export type OffscreenMessage={target:typeof OFFSCREEN_TARGET;type:'analyze';request:AnalysisRequest};
export type OffscreenReply={ok:true;result:AnalysisResult}|{ok:false};
type Sender={id?:string;tab?:unknown;url?:string};
export type OffscreenRuntime={id:string;onMessage:{addListener:(f:(message:unknown,sender:Sender,reply:(r:OffscreenReply)=>void)=>boolean|undefined)=>void}};

/** Answers only this extension's worker (no tab sender), only the analyze message. */
export function installOffscreen(runtime:OffscreenRuntime,analyze:Analyzer=request=>analyzeMoodlePage(request)) {
  runtime.onMessage.addListener((message,sender,reply)=>{
    const m=message as OffscreenMessage;
    if(!m||typeof m!=='object'||m.target!==OFFSCREEN_TARGET||m.type!=='analyze'||sender.id!==runtime.id||sender.tab!==undefined)return undefined;
    void analyze(m.request).then(result=>reply({ok:true,result}),()=>reply({ok:false}));
    return true;
  });
}
