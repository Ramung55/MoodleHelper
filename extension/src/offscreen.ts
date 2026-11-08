/**
 * #20 offscreen document (reason DOM_PARSER). An MV3 service worker has no
 * DOMParser, so the scan worker sends this page the fetched envelope and HTML
 * text; it runs the observed access check, link discovery and the live
 * registry's collectors, and replies with serializable results only. It makes
 * no network request and keeps nothing. The worker side is `offscreenAnalyzer`
 * in moodle-page-source.ts.
 *
 * #82 adds the `access` message: the course discovery run sends only a reduced
 * envelope and the `<body>` id and classes (never page text or the sesskey), and
 * this page answers with the observed access result.
 */
import {analyzeMoodlePage, checkMoodleAccess, type AccessChecker, type AccessRequest, type AnalysisRequest, type AnalysisResult, type Analyzer} from './moodle-page-analysis';
import type {MoodleAccessResult} from './moodle-access';

export const OFFSCREEN_TARGET='moodle-helper-offscreen';
export const OFFSCREEN_PATH='offscreen.html';
export type OffscreenMessage={target:typeof OFFSCREEN_TARGET;type:'analyze';request:AnalysisRequest}|{target:typeof OFFSCREEN_TARGET;type:'access';request:AccessRequest};
export type OffscreenReply={ok:true;result:AnalysisResult|MoodleAccessResult}|{ok:false};
type Sender={id?:string;tab?:unknown;url?:string};
export type OffscreenRuntime={id:string;onMessage:{addListener:(f:(message:unknown,sender:Sender,reply:(r:OffscreenReply)=>void)=>boolean|undefined)=>void}};

/** Answers only this extension's worker (no tab sender), only the analyze and access messages. */
export function installOffscreen(runtime:OffscreenRuntime,analyze:Analyzer=request=>analyzeMoodlePage(request),
  access:AccessChecker=async request=>checkMoodleAccess(request)) {
  runtime.onMessage.addListener((message,sender,reply)=>{
    const m=message as OffscreenMessage;
    if(!m||typeof m!=='object'||m.target!==OFFSCREEN_TARGET||!['analyze','access'].includes(m.type)||sender.id!==runtime.id||sender.tab!==undefined)return undefined;
    const work:Promise<AnalysisResult|MoodleAccessResult>=m.type==='analyze'?analyze(m.request):access(m.request);
    void work.then(result=>reply({ok:true,result}),()=>reply({ok:false}));
    return true;
  });
}
