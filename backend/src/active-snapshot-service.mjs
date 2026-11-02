// Private preparation and guarded reading only. These adapters do not establish
// production retention, at-rest encryption, independent copies, or permission
// to remove any live history. The HTTP gateway must independently check the
// caller's current session, tenant, member role and epoch before and after use.
import {randomUUID} from 'node:crypto';
import {canonical,id,integer,object} from './validation.mjs';
import {ACTIVE_SNAPSHOT_LIMITS as L,snapshotHash,snapshotScope,
 validateSnapshotHeader,validateSnapshotRecord,validateSnapshotPage,parseSnapshotBytes,
 snapshotContentHash,snapshotRecordKey,compareCodeUnits,pageDescriptor,safeSnapshotJson} from './active-snapshot-format.mjs';
import {isPreparedActiveSnapshotProjection} from './active-snapshot-projection.mjs';

async function reserve(budget,tenantId,costs){
 if(budget!==null)await budget.reserve({tenantId,stepId:`snapshot_${randomUUID().replaceAll('-','')}`,costs});
}

// writePage(index, bytes) must perform an immutable private write and return
// {key}. A partial failure leaves unpublished objects only; publication is an
// explicit separate operation after this function returns successfully.
export async function createActiveSnapshotPackage({projection,writePage,budget=null}){
 if(!isPreparedActiveSnapshotProjection(projection)||typeof writePage!=='function')throw new Error('snapshot-projection-required');
 const scope=snapshotScope({...projection.scope});
 if(projection.checkpointSequence!==scope.checkpointSequence)throw new Error('snapshot-checkpoint-mismatch');
 const pages=[];let records=[],recordBytes=2,totalBytes=0,recordCount=0,previous=null;
 const flush=async()=>{
  if(!records.length)return;
  if(pages.length>=L.maxPages)throw new Error('snapshot-page-limit');
  const page={snapshotId:scope.snapshotId,index:pages.length,records,sha256:snapshotHash(records)};
  const bytes=Buffer.from(canonical(page));
  if(bytes.length>L.maxPageBytes)throw new Error('snapshot-page-limit');
  totalBytes+=bytes.length;if(totalBytes>L.maxTotalBytes)throw new Error('snapshot-total-limit');
  await reserve(budget,scope.tenantId,{r2ClassA:1});
  const result=object(await writePage(page.index,bytes));
  if(typeof result.key!=='string'||!result.key.length||result.key.length>1024)throw new Error('invalid-snapshot-storage-key');
  pages.push({...pageDescriptor(page),key:result.key});records=[];recordBytes=2;
 };
 for await(const row of projection.records()){
  validateSnapshotRecord(row,scope);const order=snapshotRecordKey(row);
  if(previous!==null&&compareCodeUnits(previous,order)>=0)throw new Error('snapshot-record-order');previous=order;
  const bytes=Buffer.byteLength(canonical(row));
  if(recordBytes+bytes+(records.length?1:0)>L.pageBytes)await flush();
  records.push(structuredClone(row));recordBytes+=bytes+(records.length>1?1:0);
  if(++recordCount>L.maxRecords)throw new Error('snapshot-record-limit');
 }
 await flush();
 const header=validateSnapshotHeader({format:'active_snapshot',version:1,syncProtocolVersion:2,...scope,
  pageCount:pages.length,recordCount,contentSha256:snapshotContentHash(pages)});
 const publication={header,headerSha256:snapshotHash(header),pages,historyFloor:scope.historyFloor};
 if(Buffer.byteLength(canonical(publication))>L.maxManifestBytes)throw new Error('snapshot-manifest-limit');
 return publication;
}

function validateCaller(scope){
 object(scope);for(const key of ['tenantId','uid'])id(scope[key]);
 if(!['manager','employee'].includes(scope.role))throw new Error('invalid-snapshot-role');
 integer(scope.membershipEpoch,1,Number.MAX_SAFE_INTEGER);
 const minimumHistoryFloor=integer(scope.minimumHistoryFloor??0,0,Number.MAX_SAFE_INTEGER);
 return Object.freeze({tenantId:scope.tenantId,uid:scope.uid,role:scope.role,membershipEpoch:scope.membershipEpoch,minimumHistoryFloor});
}
function publicationIdentity(publication,caller){
 object(publication);
 safeSnapshotJson(publication);
 if(!['header','headerSha256','pages'].every(key=>Object.hasOwn(publication,key))||Object.keys(publication).some(key=>!['header','headerSha256','pages','historyFloor'].includes(key)))throw new Error('invalid-snapshot-publication');
 if(Buffer.byteLength(canonical(publication))>L.maxManifestBytes)throw new Error('snapshot-manifest-limit');
 const header=validateSnapshotHeader(publication.header,{tenantId:caller.tenantId,role:caller.role});
 if(caller.role==='employee'&&header.uid!==caller.uid)throw new Error('snapshot-projection-denied');
 if(typeof publication.headerSha256!=='string'||snapshotHash(header)!==publication.headerSha256)throw new Error('snapshot-header-integrity');
 if(!Array.isArray(publication.pages)||publication.pages.length!==header.pageCount)throw new Error('snapshot-descriptor-count');
 let count=0;const keys=new Set();
 const descriptors=publication.pages.map((page,index)=>{
  object(page);if(Object.keys(page).length!==4||!['index','sha256','recordCount','key'].every(key=>Object.hasOwn(page,key)))throw new Error('invalid-snapshot-descriptor');
  integer(page.recordCount,1,L.maxRecords);
  if(page.index!==index||typeof page.sha256!=='string'||!/^[a-f0-9]{64}$/.test(page.sha256)||typeof page.key!=='string'||!page.key.length||page.key.length>1024||keys.has(page.key))throw new Error('invalid-snapshot-descriptor');
  keys.add(page.key);count+=page.recordCount;
  return {index,sha256:page.sha256,recordCount:page.recordCount};
 });
 if(count!==header.recordCount||snapshotContentHash(descriptors)!==header.contentSha256)throw new Error('snapshot-descriptor-integrity');
 const publicationFloor=integer(publication.historyFloor??header.historyFloor,0,header.checkpointSequence);
 if(publicationFloor<header.historyFloor)throw new Error('snapshot-floor-regression');
 if(header.checkpointSequence<caller.minimumHistoryFloor)throw new Error('snapshot-checkpoint-below-history-floor');
 const historyFloor=Math.max(publicationFloor,caller.minimumHistoryFloor);
 const {minimumHistoryFloor,...bindingScope}=caller;
 const snapshotId=`snap_${snapshotHash({sourceHeaderSha256:publication.headerSha256,...bindingScope,historyFloor})}`;
 const boundHeader=validateSnapshotHeader({...header,...bindingScope,historyFloor,snapshotId});
 return {header:boundHeader,headerSha256:snapshotHash(boundHeader),identity:snapshotHash(publication)};
}

// catalog.latest({tenantId,uid,role}) returns a trusted private publication from
// createActiveSnapshotPackage. Manager publications can serve fresh managers;
// employee publications MUST already contain only that UID's server projection.
// storage.read(key,{maxBytes}) must enforce the byte cap before buffering. A
// production adapter must add its own encryption and durability acceptance.
// minimumHistoryFloor is trusted gateway metadata, never a public request field.
export function createActiveSnapshotService({catalog,storage,assertAuthority=null,budget=null}){
 if(typeof catalog?.latest!=='function'||typeof storage?.read!=='function'||(assertAuthority!==null&&typeof assertAuthority!=='function')||(budget!==null&&typeof budget?.reserve!=='function'))throw new Error('active-snapshot-not-configured');
 const guard=async caller=>{if(assertAuthority!==null&&await assertAuthority(caller)===false)throw new Error('snapshot-authority-changed');};
 const latest=async caller=>{
  await reserve(budget,caller.tenantId,{firestoreReads:1});
  const publication=await catalog.latest({tenantId:caller.tenantId,uid:caller.uid,role:caller.role});
  if(!publication)throw new Error('active-snapshot-unavailable');
  const owned=structuredClone(publication);return {publication:owned,...publicationIdentity(owned,caller)};
 };
 const unchanged=async(caller,identity)=>{if((await latest(caller)).identity!==identity)throw new Error('snapshot-publication-changed');await guard(caller);};
 return Object.freeze({
  async getHeader(scope){
   const caller=validateCaller(scope);await guard(caller);const active=await latest(caller);
   await unchanged(caller,active.identity);return {header:active.header,headerSha256:active.headerSha256};
  },
  async readPage(scope){
   const caller=validateCaller(scope);id(scope.snapshotId);integer(scope.index,0,L.maxPages-1);
   if(typeof scope.headerSha256!=='string'||!/^[a-f0-9]{64}$/.test(scope.headerSha256))throw new Error('snapshot-header-integrity');
   await guard(caller);const active=await latest(caller);
   if(scope.snapshotId!==active.header.snapshotId||scope.headerSha256!==active.headerSha256)throw new Error('snapshot-publication-changed');
   integer(scope.index,0,active.header.pageCount-1);const descriptor=active.publication.pages[scope.index];
   await reserve(budget,caller.tenantId,{r2ClassB:1,downloadBytes:L.maxPageBytes});
   const source=validateSnapshotPage(parseSnapshotBytes(await storage.read(descriptor.key,{maxBytes:L.maxPageBytes}),L.maxPageBytes),active.publication.header,scope.index);
   if(source.sha256!==descriptor.sha256||source.records.length!==descriptor.recordCount)throw new Error('snapshot-page-integrity');
   const page=validateSnapshotPage({...source,snapshotId:active.header.snapshotId},active.header,scope.index);
   await unchanged(caller,active.identity);return {page,header:active.header,headerSha256:active.headerSha256};
  },
 });
}
