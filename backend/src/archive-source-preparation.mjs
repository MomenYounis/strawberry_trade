// Private Node operator runtime. Encrypted, resumable source capture lets an
// annual job spend a bounded source-read allowance across many invocations.
// No production scheduler, credential, bucket, or cleanup is enabled here.
import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {createArchiveProjection} from './archive-projection.mjs';
import {isVerifiedManagerSnapshotProjection} from './active-snapshot-projection.mjs';

const MAX_PAGE=65_536,MAX_PAGES=10_000,MAX_BYTES=268_435_456,MAX_RECORDS=500_000;
const hash=bytes=>createHash('sha256').update(typeof bytes==='string'?bytes:canonical(bytes)).digest('hex');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const factories=new WeakSet();
export const isPreparedArchiveSourceFactory=value=>factories.has(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function keyBytes(master,context,index){
 if(!(master instanceof Uint8Array)||master.byteLength!==32)throw Error('archive-key-required');
 return Buffer.from(hkdfSync('sha256',master,Buffer.from(`${context.tenantId}/${context.runId}/${context.keyId}`),Buffer.from(`strawberry-source-preparation-v1/${index}`),32));
}
function aad(context,index){return Buffer.from(canonical({format:'annual-source-preparation',version:1,context,index}));}
function namespace(context){return `archives/v1/${context.tenantId}/${context.year}/${context.runId}/chunks/`;}
function seal(page,master,context){
 const plain=Buffer.from(canonical(page));if(plain.length>MAX_PAGE)throw Error('source-page-limit');
 const key=keyBytes(master,context,page.index),nonce=randomBytes(12);
 try{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(context,page.index));return {bytes:Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]),plainBytes:plain.length};}
 finally{key.fill(0);plain.fill(0);}
}
function descriptor(value,context){
 if(!value||Object.keys(value).sort().join('|')!=='from|index|key|sha256|to'||!hex(value.sha256)||value.key!==namespace(context)+value.sha256)throw Error('source-page-identity');
 integer(value.index,0,MAX_PAGES-1);integer(value.from,1,context.closingSequence);integer(value.to,value.from,context.closingSequence);return value;
}
async function readPage(storage,head,master,context,budget,beforeWork=async()=>{}){
 await beforeWork();
 descriptor(head,context);await budget.reserve({tenantId:context.tenantId,stepId:'source_read_'+head.index,costs:{r2ClassB:1,downloadBytes:MAX_PAGE+28}});
 await beforeWork();
 const bytes=await storage.read(head.key,{maxBytes:MAX_PAGE+28});
 await beforeWork();
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<28||bytes.byteLength>MAX_PAGE+28||sha(bytes)!==head.sha256)throw Error('source-page-integrity');
 const key=keyBytes(master,context,head.index);let plain;
 try{const raw=Buffer.from(bytes),decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAAD(aad(context,head.index));decipher.setAuthTag(raw.subarray(-16));plain=Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]);}
 catch{throw Error('source-page-authentication');}finally{key.fill(0);}
 try{
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(plain),page=JSON.parse(raw);
  if(plain.length>MAX_PAGE||canonical(page)!==raw||Object.keys(page).sort().join('|')!=='contextSha256|from|index|previous|records|to'||page.contextSha256!==hash(context)||page.index!==head.index||page.from!==head.from||page.to!==head.to||!Array.isArray(page.records)||page.records.length!==head.to-head.from+1)throw Error('source-page-schema');
  if(page.previous!==null){descriptor(page.previous,context);if(page.previous.index!==head.index-1||page.previous.to!==page.from-1)throw Error('source-chain-gap');}
  page.records.forEach((row,index)=>validateChange(row,context,page.from+index));return page;
 }finally{plain.fill(0);}
}
function validateChange(row,context,expected){
 if(!row||row.sequence!==expected||!['party','employee','salary_term','entry','submission','review'].includes(row.entity)||row.id!==row.payload?.id||row.payload?.tenantId!==context.tenantId)throw Error('source-sequence-or-scope');
 id(row.id);integer(row.sequence,1,context.closingSequence);
 const bytes=Buffer.byteLength(canonical(row));if(bytes>24_000)throw Error('source-record-limit');return bytes;
}
async function stateCall(store,method,args,budget,tenantId){
 await budget.reserve({tenantId,stepId:'source_state_'+method,costs:{firestoreReads:15,firestoreWrites:10}});
 return store[method](...args);
}
async function contextFor(stateStore,tenantId,year,run,keyId,budget){
 let previousCloseHash=null;
 if(year>2026){const previous=await stateCall(stateStore,'read',[tenantId,year-1],budget,tenantId);
  if(!previous?.manifest||previous.runId!==run.checkpoint.previousClose||previous.evidence?.verified?.manifestSha256!==previous.manifest.sha256)throw Error('previous-verified-archive-required');previousCloseHash=previous.manifest.sha256;
 }
 return {tenantId,year,runId:run.runId,closingSequence:run.checkpoint.sequence,closingVersion:run.checkpoint.version,previousCloseHash,keyId,createdAtMs:run.createdAtMs};
}
function validateProgress(progress,context){
 if(!progress||progress.version!==1||progress.contextSha256!==hash(context)||progress.keyId!==context.keyId)throw Error('source-preparation-context');
 integer(progress.fromSequence,0,context.closingSequence);integer(progress.sourceCursor,progress.fromSequence,context.closingSequence);integer(progress.pageCount,0,MAX_PAGES);integer(progress.sourceBytes,0,MAX_BYTES);
 if(progress.sourceCursor-progress.fromSequence>MAX_RECORDS||progress.seedSequence!==progress.fromSequence||!(progress.seedSha256===null||hex(progress.seedSha256)))throw Error('source-preparation-limit');
 if(progress.head===null){if(progress.sourceCursor!==progress.fromSequence||progress.pageCount!==0||progress.sourceBytes!==0)throw Error('source-preparation-gap');}
 else{descriptor(progress.head,context);if(progress.head.to!==progress.sourceCursor||progress.head.index!==progress.pageCount-1)throw Error('source-preparation-gap');}
 return progress;
}
async function seedHash(seed,beforeWork=async()=>{}){
 const digest=createHash('sha256');let records=0;
 for await(const row of seed.iterateFullRecords()){
  if(records++%128===0)await beforeWork();
  digest.update(canonical(row)+'\n');
 }
 await beforeWork();return digest.digest('hex');
}

export async function prepareArchiveSourceStep({stateStore,tenantId,year,lease,source,storage,masterKey,keyId,budget,seedProvider=null,pageSize=50,maxNewPages=2,now=Date.now}){
 id(tenantId);id(keyId);integer(pageSize,1,100);integer(maxNewPages,1,4);
 if(!budget?.reserve||typeof source?.readState!=='function'||typeof source?.readChanges!=='function'||typeof storage?.putImmutable!=='function')throw Error('source-preparation-configuration');
 let currentLease=lease;
 let run=await stateCall(stateStore,'assertCurrent',[tenantId,year,currentLease],budget,tenantId);
 if(!['checkpointed','exporting'].includes(run.state)||!run.checkpoint)throw Error('archive-checkpoint-required');
 const context=await contextFor(stateStore,tenantId,year,run,keyId,budget);
 await budget.reserve({tenantId,stepId:'source_live_state',costs:{firestoreReads:1}});
 const live=await source.readState({tenantId});
 if(!live||live.enabled!==true||live.adminDeleting||!Number.isSafeInteger(live.sequence)||live.sequence<context.closingSequence)throw Error('tenant-not-active');
 const floor=integer(live.historyFloor??0,0,context.closingSequence);let progress=run.sourcePreparation;
 if(progress){validateProgress(progress,context);if(progress.fromSequence<floor)throw Error('source-seed-required');
  // Authentication of the original key/context precedes any append/publication.
  if(progress.head)await readPage(storage,progress.head,masterKey,context,budget);
 }else{
  let seed=null,fromSequence=0,seedSha256=null;
  try{
   if(floor>0){seed=await seedProvider?.({context,historyFloor:floor,budget});if(!isVerifiedManagerSnapshotProjection(seed)||seed.scope.tenantId!==tenantId||seed.checkpointSequence<floor||seed.checkpointSequence>context.closingSequence)throw Error('verified-manager-snapshot-required');fromSequence=seed.checkpointSequence;seedSha256=await seedHash(seed);}
  }finally{await seed?.destroy?.();}
  progress={version:1,contextSha256:hash(context),keyId,fromSequence,sourceCursor:fromSequence,head:null,pageCount:0,sourceBytes:0,seedSequence:fromSequence,seedSha256};
  if(context.closingSequence-fromSequence>MAX_RECORDS)throw Error('source-preparation-limit');
  await stateCall(stateStore,'recordSourcePreparation',[tenantId,year,currentLease,progress],budget,tenantId);
 }
 if(progress.sourceCursor===context.closingSequence)return {state:'prepared',progress,lease:currentLease};
 await budget.reserve({tenantId,stepId:'source_feed_'+progress.sourceCursor,costs:{firestoreReads:pageSize+1}});
 const changes=await source.readChanges({tenantId,afterSequence:progress.sourceCursor,throughSequence:context.closingSequence,limit:pageSize});
 if(!Array.isArray(changes)||!changes.length||changes.length>pageSize)throw Error('source-sequence-gap');
 changes.forEach((row,index)=>validateChange(row,context,progress.sourceCursor+index+1));
 let offset=0,newPages=0;
 while(offset<changes.length&&newPages<maxNewPages){
  if(progress.pageCount>=MAX_PAGES)throw Error('source-page-count-limit');
  const rows=[];const page={contextSha256:hash(context),index:progress.pageCount,from:progress.sourceCursor+1,to:progress.sourceCursor,previous:progress.head,records:rows};
  while(offset+rows.length<changes.length){
   const row=changes[offset+rows.length];rows.push(row);page.to=row.sequence;
   if(Buffer.byteLength(canonical(page))>MAX_PAGE){rows.pop();page.to=progress.sourceCursor+rows.length;break;}
  }
  if(!rows.length)throw Error('source-record-limit');
  const sealed=seal(page,masterKey,context);if(progress.sourceBytes+sealed.plainBytes>MAX_BYTES)throw Error('source-preparation-limit');
  if(currentLease.expiresAtMs-now()<30_000)currentLease=await stateCall(stateStore,'renew',[tenantId,year,currentLease],budget,tenantId);
  await stateCall(stateStore,'assertCurrent',[tenantId,year,currentLease],budget,tenantId);
  await budget.reserve({tenantId,stepId:'source_upload_'+page.index,costs:{r2ClassA:1}});
  const sha256=sha(sealed.bytes),key=namespace(context)+sha256;await storage.putImmutable(key,sealed.bytes);
  progress={...progress,sourceCursor:page.to,head:{index:page.index,from:page.from,to:page.to,key,sha256},pageCount:progress.pageCount+1,sourceBytes:progress.sourceBytes+sealed.plainBytes};
  await stateCall(stateStore,'recordSourcePreparation',[tenantId,year,currentLease,progress],budget,tenantId);
  offset+=rows.length;newPages++;
 }
 return {state:progress.sourceCursor===context.closingSequence?'prepared':'preparing',progress,lease:currentLease};
}

export function preparedArchiveSourceFactory({stateStore,storage,masterKey,budget,seedProvider=null}){
 if(!budget?.reserve)throw Error('archive-work-budget-required');
 const factory=async(context,{beforeWork=async()=>{}}={})=>{
  if(typeof beforeWork!=='function')throw Error('source-progress-check-required');
  context=Object.freeze(structuredClone(context));
  await beforeWork();
  const run=await stateCall(stateStore,'read',[context.tenantId,context.year],budget,context.tenantId),progress=validateProgress(run?.sourcePreparation,context);
  if(progress.sourceCursor!==context.closingSequence)throw Error('source-preparation-incomplete');
  // Only bounded descriptors are retained, never complete yearly payloads.
  const reverse=[];let cursor=progress.head,expected=context.closingSequence,sourceBytes=0;
  while(cursor){
   if(reverse.length>=MAX_PAGES||cursor.to!==expected)throw Error('source-chain-gap');
   const page=await readPage(storage,cursor,masterKey,context,budget,beforeWork);sourceBytes+=Buffer.byteLength(canonical(page));if(sourceBytes>MAX_BYTES)throw Error('source-preparation-limit');reverse.push(cursor);expected=page.from-1;cursor=page.previous;
  }
  if(expected!==progress.fromSequence||reverse.length!==progress.pageCount||sourceBytes!==progress.sourceBytes)throw Error('source-chain-gap');
  let seed=null,projection;
  try{
   if(progress.fromSequence>0){await beforeWork();seed=await seedProvider?.({context,historyFloor:progress.fromSequence,budget});
    if(!isVerifiedManagerSnapshotProjection(seed)||seed.scope.tenantId!==context.tenantId||seed.checkpointSequence!==progress.seedSequence||await seedHash(seed,beforeWork)!==progress.seedSha256)throw Error('source-seed-changed');
   }
   await beforeWork();
   projection=await createArchiveProjection({context,seed,beforeWork});
   async function* records(){for(let index=reverse.length-1;index>=0;index--){const page=await readPage(storage,reverse[index],masterKey,context,budget,beforeWork);for(const row of page.records)yield row;}}
   await projection.ingest(records());await beforeWork();return projection;
  }catch(error){await projection?.destroy();throw error;}finally{await seed?.destroy?.();}
 };
 factories.add(factory);return factory;
}

export function firestorePreparationSource(db){return {
 async readState({tenantId}){return (await db.doc('tenants/'+id(tenantId)).get()).data();},
 async readChanges({tenantId,afterSequence,throughSequence,limit}){
  const page=await db.doc('tenants/'+id(tenantId)).collection('changes').where('sequence','>',afterSequence).where('sequence','<=',throughSequence).orderBy('sequence').limit(limit).get();
  return page.docs.map(doc=>doc.data());
 },
};}
