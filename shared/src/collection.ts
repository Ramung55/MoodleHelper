/** Internal isolated-world protocol, deliberately outside the dashboard catalog. */
import { closed, fits, idValid, validSchema } from './bridge';
import type { CollectionContext, BeginPageVisit, PageVisitToken, PageRefreshInput, PageRefreshReceipt, Snapshot } from '../../frontend/src/domain/types';
export type { CollectionContext, PageVisitToken, PageRefreshInput };
export type RefreshResponse = {snapshot: Snapshot;receipt: PageRefreshReceipt};
export type CollectionOperation = 'collectionContext'|'beginPageVisit'|'ingestPageRefresh';
export type CollectionRequest = {source:'moodle-helper-collection';version:'1';requestId:string;operation:CollectionOperation;binding?:string;payload:Record<string,never>|Omit<BeginPageVisit,'documentKey'>|PageRefreshInput};
export type CollectionReply = {requestId:string;ok:true;result:CollectionContext|PageVisitToken|RefreshResponse}|{requestId:string;ok:false;reason:CollectionError};
export type CollectionError = 'invalid_request'|'permission_denied'|'context_changed'|'backend_unavailable'|'invalid_response'|'busy'|'duplicate_conflict'|'timeout';
export function collectionRequest(value: unknown): value is CollectionRequest {
  if (!fits(value) || !closed(value,['source','version','requestId','operation','payload'],['binding']) || value.source!=='moodle-helper-collection' || value.version!=='1' || !idValid(value.requestId)) return false;
  if(value.operation==='collectionContext') return value.binding===undefined && closed(value.payload,[]);
  if(typeof value.binding!=='string' || !/^[a-f0-9]{32}$/.test(value.binding)) return false;
  if(value.operation==='beginPageVisit') return closed(value.payload,['visitId','pageUrl','selectionRevision']) && validSchema('BeginPageVisit',{...value.payload,documentKey:'derived'});
  return value.operation==='ingestPageRefresh' && validSchema('PageRefreshInput',value.payload);
}
export function collectionResponse(operation:CollectionOperation,value:unknown):boolean {
  return validSchema({collectionContext:'CollectionContext',beginPageVisit:'PageVisitToken',ingestPageRefresh:'PageRefreshResponse'}[operation],value);
}
