import { BACKEND, type Sender, type Runtime } from './dashboard-bridge';
import { closed, normalized, fits, idValid } from '../../shared/src/bridge';
import { collectionRequest, collectionResponse, type CollectionRequest, type CollectionReply, type CollectionError, type CollectionContext, type PageVisitToken, type PageRefreshInput, type RefreshResponse } from '../../shared/src/collection';
const ORIGIN='https://moodle.sdu.edu.kz';
export function collectionSender(sender:Sender,runtimeId:string):boolean {
  try {
    const url=new URL(sender.url!);
    return sender.id===runtimeId && sender.frameId===0 && Number.isInteger(sender.tab?.id) && sender.tab!.id!>=0 && !!sender.documentId && idValid(sender.documentId) && url.origin===ORIGIN && !url.username && !url.password && sender.url!.startsWith(ORIGIN+'/') && (sender.origin===undefined||sender.origin===ORIGIN) && (sender.tab?.url===undefined||new URL(sender.tab.url).origin===ORIGIN);
  } catch {return false;}
}
/** Fixed loopback operations. Serializes begins/commits per browser document. */
export function createCollectionWorker(options:{runtimeId:string;grant:()=>Promise<boolean>;fetcher?:typeof fetch;timeout?:number}) {
  const pending=new Map<string,{signature:string;reply:Promise<CollectionReply>;done:boolean}>();
  const queues=new Map<string,Promise<unknown>>();
  const contexts=new Map<string,string>();
  const fetcher=options.fetcher??fetch;
  return async (value:unknown,sender:Sender):Promise<CollectionReply|undefined>=>{
    if(!collectionSender(sender,options.runtimeId)) return;
    if(!collectionRequest(value)) return {requestId:closed(value,['requestId'],Object.keys((value as object)||{})) && idValid(value.requestId)?value.requestId:'invalid',ok:false,reason:'invalid_request'};
    const r=value; const owner=`${sender.tab!.id}:${sender.documentId}`;
    const key=owner+':'+r.requestId; const signature=normalized(r);
    const old=pending.get(key);
    if(old) return old.signature===signature?old.reply:{requestId:r.requestId,ok:false,reason:'duplicate_conflict'};
    if([...pending.entries()].filter(([key,value])=>key.startsWith(owner+':')&&!value.done).length>=32)return {requestId:r.requestId,ok:false,reason:'busy'};
    if(pending.size>=256) {
      for(const [key,entry] of pending) if(entry.done) pending.delete(key);
      if(pending.size>=256) return {requestId:r.requestId,ok:false,reason:'busy'};
    }
    const execute=async ():Promise<CollectionReply>=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        if(!await options.grant()) throw 'permission_denied';
        if(r.operation!=='collectionContext' && contexts.get(owner)!==r.binding) throw 'context_changed';
        if(r.operation==='beginPageVisit' && (r.payload as {pageUrl:string}).pageUrl!==sender.url) throw 'invalid_request';
        const route={collectionContext:'/api/collection-context',beginPageVisit:'/api/collection/visits',ingestPageRefresh:'/api/collection/refresh'}[r.operation];
        const payload=r.operation==='beginPageVisit'?{...r.payload,documentKey:owner}:r.payload;
        const controller=new AbortController();timer=setTimeout(()=>controller.abort(),options.timeout??10000);
        let response:Response;
        try {response=await fetcher(BACKEND+route,{method:r.operation==='collectionContext'?'GET':'POST',credentials:'omit',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(r.operation==='collectionContext'?{}:{'Content-Type':'application/json','X-Moodle-Helper-Bridge-Binding':r.binding!})},...(r.operation==='collectionContext'?{}:{body:JSON.stringify(payload)})});}
        catch {throw controller.signal.aborted?'timeout':'backend_unavailable';}
        if(response.status===409) {contexts.delete(owner);throw 'context_changed';}
        if(!response.ok) throw 'backend_unavailable';
        const body=await response.text();if(new TextEncoder().encode(body).length>1024*1024) throw 'invalid_response';
        let result:unknown;try {result=JSON.parse(body);}catch {throw 'invalid_response';}
        if(!collectionResponse(r.operation,result)) throw 'invalid_response';
        if(!await options.grant()) {contexts.delete(owner);throw 'permission_denied';}
        if(r.operation==='collectionContext') {
          if(contexts.size>=128&&!contexts.has(owner)) contexts.delete(contexts.keys().next().value!);
          contexts.set(owner,(result as CollectionContext).binding);
        }
        return {requestId:r.requestId,ok:true,result:result as CollectionContext|PageVisitToken|RefreshResponse};
      }catch(e){
        const allowed=['invalid_request','permission_denied','context_changed','backend_unavailable','invalid_response','busy','timeout'];
        return {requestId:r.requestId,ok:false,reason:typeof e==='string'&&allowed.includes(e)?e as CollectionError:'backend_unavailable'};
      }finally {if(timer!==undefined)clearTimeout(timer);}
    };
    const entry={signature,reply:Promise.resolve(null as unknown as CollectionReply),done:false};pending.set(key,entry);
    const queued=(queues.get(owner)??Promise.resolve()).then(execute,execute);
    queues.set(owner,queued);
    entry.reply=queued.finally(()=>{entry.done=true;if(queues.get(owner)===queued)queues.delete(owner);});
    return entry.reply;
  };
}
export class CollectionTransportError extends Error {constructor(public reason:CollectionError){super(reason);}}
export interface CollectionRepository {
  context():Promise<CollectionContext>;
  begin(body:{visitId:string;pageUrl:string;selectionRevision:string},binding:string):Promise<PageVisitToken>;
  refresh(body:PageRefreshInput,binding:string):Promise<RefreshResponse>;
}
export function runtimeCollectionRepository(runtime:Runtime,uuid=()=>crypto.randomUUID()):CollectionRepository {
  const send=(operation:CollectionRequest['operation'],payload:CollectionRequest['payload'],binding?:string):Promise<unknown>=>new Promise((resolve,reject)=>{
    const request:CollectionRequest={source:'moodle-helper-collection',version:'1',requestId:uuid(),operation,payload,...(binding?{binding}:{})};
    const timer=setTimeout(()=>reject(new CollectionTransportError('timeout')),11000);
    try {runtime.sendMessage!(request,(reply:unknown)=>{
      clearTimeout(timer);
      if(runtime.lastError)return reject(new CollectionTransportError('context_changed'));
      if(!fits(reply)||!closed(reply,['requestId','ok'],['result','reason'])||reply.requestId!==request.requestId)return reject(new CollectionTransportError('invalid_response'));
      if(reply.ok===true&&closed(reply,['requestId','ok','result'])&&collectionResponse(operation,reply.result))resolve(reply.result);
      else if(reply.ok===false&&closed(reply,['requestId','ok','reason'])&&['invalid_request','permission_denied','context_changed','backend_unavailable','invalid_response','busy','duplicate_conflict','timeout'].includes(reply.reason))reject(new CollectionTransportError(reply.reason));
      else reject(new CollectionTransportError('invalid_response'));
    });}catch{clearTimeout(timer);reject(new CollectionTransportError('context_changed'));}
  });
  return {context:()=>send('collectionContext',{}) as Promise<CollectionContext>,begin:(body,binding)=>send('beginPageVisit',body,binding) as Promise<PageVisitToken>,refresh:(body,binding)=>send('ingestPageRefresh',body,binding) as Promise<RefreshResponse>};
}
export function installCollectionWorker(api:Parameters<typeof import('./dashboard-bridge').installWorker>[0]) {
  const handler=createCollectionWorker({runtimeId:api.runtime.id,grant:()=>new Promise(resolve=>api.permissions.contains({origins:[BACKEND+'/*']},allowed=>resolve(!api.runtime.lastError&&allowed)))});
  api.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!message||message.source!=='moodle-helper-collection'||!collectionSender(sender,api.runtime.id))return;
    void handler(message,sender).then(value=>{if(value)reply(value as never);});return true;
  });
}
