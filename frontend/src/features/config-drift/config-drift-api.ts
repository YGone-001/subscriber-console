import { postJson, putJson } from '../../lib/api/mutation-client';
export type DriftEvidence = {observationId:string;snapshotId:string;comparison:string;at:string;sequence:number};
export type DriftAlert = {driftAlertId:string;sourceId:string;sourceName:string;resourceId:string;generation:string;profile:string;baselineId:string;baselineRevision:number;policyRevision:number;severity:string;state:string;endReason:string;revision:number;triggerCount:number;openedAt:string;resolvedAt:string|null;acknowledgedAt:string|null;acknowledgedBy:string;trigger:DriftEvidence;latest:DriftEvidence};
export type DriftEvent = {eventId:string;driftAlertId:string;sourceId:string;kind:string;reason:string;at:string;actor:string;evidence:DriftEvidence};
export type DriftPage<T> = {items:T[];nextCursor:string|null;hasMore:boolean};
export type DriftList = DriftPage<DriftAlert>&{summary:Record<string,number>|null;completeness:string};
export type DriftPolicy = {enabled:boolean;severity:string;revision:number;updatedAt:string;updatedBy:string};
export type DriftPolicyView = {sourceId:string;policy:DriftPolicy;registered:boolean;resourceState:string;baselineId:string;baselineRevision:number;collectionState:string;publicationPending:boolean;publishedSequence:number;queuedInputs:number;evaluation:{state:string;reason:string;processedSequence:number;evaluatedAt:string;lastVerified:DriftEvidence|null};openAlertId:string;freshness:string};
export function driftPolicyPath(id:string){return '/api/config-drift/sources/'+encodeURIComponent(id)+'/policy';}
export function driftAlertPath(id:string){return '/api/config-drift/alerts/'+encodeURIComponent(id);}
export function driftListPath(params:URLSearchParams){const q=new URLSearchParams({limit:'25',state:params.get('state')||'open'});for(const key of ['sourceId','resourceId','severity','cursor','networkKey','siteResourceId','hostResourceId','operatorName','plmn','domain','includeRetired']){const v=params.get(key);if(v)q.set(key,v);}if(q.get('state')==='all')q.delete('state');return '/api/config-drift/alerts?'+q;}
export function driftLink(id:string,returnTo='/config-snapshots?view=drift'){return '/config-snapshots?'+new URLSearchParams({view:'drift',driftAlertId:id,returnTo});}
export function saveDriftPolicy(id:string,expectedRevision:number,enabled:boolean,severity:string){return putJson<DriftPolicyView>(driftPolicyPath(id),{expectedRevision,enabled,severity});}
export function acknowledgeDrift(a:DriftAlert){return postJson<DriftAlert>(driftAlertPath(a.driftAlertId)+'/acknowledge',{expectedRevision:a.revision});}
export function configInvestigationEntry(id:string,current:string){return '/investigations?'+new URLSearchParams({view:'context',anchorKind:'config_drift',anchorId:id,alertReturnTo:current});}