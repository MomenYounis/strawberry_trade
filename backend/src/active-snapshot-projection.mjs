// Private preparation primitive. No routes, schedules, live mutations, key
// creation, baseline posting, or production durability claim.
import {DatabaseSync} from 'node:sqlite';
import {chmod} from 'node:fs/promises';
import {createPrivateScratch} from './private-scratch.mjs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,id,integer,keys} from './validation.mjs';
import {ACTIVE_SNAPSHOT_LIMITS as L,snapshotScope,snapshotHash,validateSnapshotHeader,validateSnapshotRecord,
 validateSnapshotPage,pageDescriptor,snapshotContentHash,snapshotRecordKey,compareCodeUnits,safeSnapshotJson} from './active-snapshot-format.mjs';

const verifiedManagerProjections=new WeakSet();
const sealedProjections=new WeakSet();
export const isVerifiedManagerSnapshotProjection=value=>Boolean(value&&verifiedManagerProjections.has(value));
export const isPreparedActiveSnapshotProjection=value=>Boolean(value&&sealedProjections.has(value));

async function reserveSource(budget,tenantId,reads){if(budget!==null)await budget.reserve({tenantId,stepId:`snapshot_${randomUUID().replaceAll('-','')}`,costs:{firestoreReads:reads}});}
export async function captureActiveSnapshotScope({db,snapshotId,tenantId,uid,role,membershipEpoch,budget=null}){
 id(snapshotId);id(tenantId);id(uid);integer(membershipEpoch,1,Number.MAX_SAFE_INTEGER);
 if(!['manager','employee'].includes(role))throw new Error('invalid-snapshot-role');
 const root=db.doc(`tenants/${tenantId}`);
 // Up to three reads per attempt (tenant/member/employee). Reserve all
 // permitted SDK retries before opening the provider transaction.
 await reserveSource(budget,tenantId,15);
 return db.runTransaction(async tx=>{
  const [tenantDoc,memberDoc]=await Promise.all([tx.get(root),tx.get(root.collection('members').doc(uid))]);
  const tenant=tenantDoc.data(),member=memberDoc.data();
  if(!tenant||tenant.adminDeleting||!member?.active||member.role!==role||(member.epoch??1)!==membershipEpoch)throw new Error('snapshot-authority-changed');
  if(role==='employee'){
   id(member.employeeId);const employee=(await tx.get(root.collection('employees').doc(member.employeeId))).data();
   if(employee?.active!==true)throw new Error('snapshot-authority-changed');
  }
  return snapshotScope({snapshotId,tenantId,uid,role,membershipEpoch,checkpointSequence:tenant.sequence??0,historyFloor:tenant.historyFloor??0});
 },{maxAttempts:5});
}

export async function* immutableActiveChangesAtCheckpoint(db,{tenantId,checkpointSequence,fromSequence=0,historyFloor=0,pageSize=100,maxPages=5001,budget=null}){
 id(tenantId);integer(checkpointSequence,0,Number.MAX_SAFE_INTEGER);integer(fromSequence,0,checkpointSequence);integer(historyFloor,0,checkpointSequence);integer(pageSize,1,250);integer(maxPages,1,10000);
 if(fromSequence<historyFloor)throw new Error('snapshot-seed-required');let after=fromSequence;
 if(after===checkpointSequence)return;
 for(let page=0;page<maxPages;page++){
  await reserveSource(budget,tenantId,pageSize);
  const docs=(await db.doc(`tenants/${tenantId}`).collection('changes').where('sequence','>',after).where('sequence','<=',checkpointSequence).orderBy('sequence').limit(pageSize).get()).docs;
  if(!docs.length)throw new Error('snapshot-history-gap');
  for(const doc of docs){const row=doc.data();if(row.sequence!==after+1||row.sequence>checkpointSequence)throw new Error('snapshot-history-gap');after=row.sequence;yield row;}
  if(after===checkpointSequence)return;
 }
 throw new Error('snapshot-source-page-limit');
}

export async function createActiveSnapshotProjection({scope,seed=null,maxChanges=L.maxRecords,maxBytes=L.maxTotalBytes}){
 scope=Object.freeze(structuredClone(snapshotScope(scope)));integer(maxChanges,1,L.maxRecords);integer(maxBytes,1024,L.maxTotalBytes);
 const scratch=await createPrivateScratch('active_snapshot'),directory=scratch.directory;let db;
 try{db=new DatabaseSync(join(directory,'projection.sqlite'));await chmod(join(directory,'projection.sqlite'),0o600);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; CREATE TABLE records(entity TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL UNIQUE,payload TEXT NOT NULL,PRIMARY KEY(entity,id));');
 }catch(error){db?.close();await scratch.destroy();throw error;}
 const get=db.prepare('SELECT sequence,payload FROM records WHERE entity=? AND id=?');
 const insert=db.prepare('INSERT INTO records(entity,id,sequence,payload) VALUES(?,?,?,?)');
 const save=db.prepare('INSERT INTO records(entity,id,sequence,payload) VALUES(?,?,?,?) ON CONFLICT(entity,id) DO UPDATE SET sequence=excluded.sequence,payload=excluded.payload');
 let sequence=0,changeCount=0,sourceBytes=0,recordCount=0,sealed=false,destroyed=false,failed=false,projection,sourceFeedSha256=null,sourceDocumentHashesSha256=null;
 const feedDigest=createHash('sha256'),documentHashesDigest=createHash('sha256');
 const managerScope={...scope,role:'manager'};
 const destroy=async()=>{if(destroyed)return;destroyed=true;if(projection){verifiedManagerProjections.delete(projection);sealedProjections.delete(projection);}try{db.close();}finally{await scratch.destroy();}};
 try{
  if(seed){
   const header=validateSnapshotHeader(structuredClone(seed.header),{tenantId:scope.tenantId,role:'manager'});
   if(typeof seed.expectedHeaderSha256!=='string'||snapshotHash(header)!==seed.expectedHeaderSha256||typeof seed.readPage!=='function')throw new Error('trusted-snapshot-seed-required');
   if(header.checkpointSequence>scope.checkpointSequence||header.checkpointSequence<scope.historyFloor)throw new Error('snapshot-seed-checkpoint-mismatch');
   let previous=null,wireBytes=0;const descriptors=[];
   for(let index=0;index<header.pageCount;index++){
    const page=validateSnapshotPage(await seed.readPage(index),header,index);descriptors.push(pageDescriptor(page));
    wireBytes+=Buffer.byteLength(canonical(page));if(wireBytes>L.maxTotalBytes)throw new Error('snapshot-total-limit');
    for(const row of page.records){
     const order=snapshotRecordKey(row);if(previous!==null&&compareCodeUnits(previous,order)>=0)throw new Error('snapshot-record-order');previous=order;
     const encoded=canonical(row.payload);sourceBytes+=Buffer.byteLength(canonical(row));recordCount++;
     if(sourceBytes>maxBytes||recordCount>L.maxRecords)throw new Error('snapshot-source-limit');
     // Primary/sequence uniqueness rejects collisions in a malicious seed.
     insert.run(row.entity,row.payload.id,row.sequence,encoded);
    }
   }
   if(recordCount!==header.recordCount||snapshotContentHash(descriptors)!==header.contentSha256)throw new Error('snapshot-seed-integrity');
   sequence=header.checkpointSequence;
  }else if(scope.historyFloor>0)throw new Error('snapshot-seed-required');
 }catch(error){await destroy();throw error;}
 function* fullRecords(){
  if(destroyed||!sealed)throw new Error('snapshot-source-not-sealed');
  for(const row of db.prepare('SELECT entity,sequence,payload FROM records ORDER BY entity COLLATE BINARY,sequence,id COLLATE BINARY').iterate())yield {entity:row.entity,payload:JSON.parse(row.payload),sequence:row.sequence};
 }
 projection=Object.freeze({scope,seedSequence:sequence,sourceFromSequence:sequence,isolated:true,
  get checkpointSequence(){if(!sealed||destroyed)throw new Error('snapshot-source-not-sealed');return sequence;},
  get sourceFeedSha256(){if(!sealed||destroyed)throw new Error('snapshot-source-not-sealed');return sourceFeedSha256;},
  get sourceDocumentHashesSha256(){if(!sealed||destroyed)throw new Error('snapshot-source-not-sealed');return sourceDocumentHashesSha256;},
  async ingest(changes){
   if(destroyed||sealed||failed)throw new Error('snapshot-source-closed');
   try{
   for await(const change of changes){
    safeSnapshotJson(change);
    keys(change,['entity','id','payload','sequence','acceptedAtMs','closeVersion']);
    if(change.acceptedAtMs!==undefined)integer(change.acceptedAtMs,0,8_640_000_000_000_000);
    if(change.closeVersion!==undefined)integer(change.closeVersion,0,Number.MAX_SAFE_INTEGER);
    if(change.sequence!==sequence+1||change.sequence>scope.checkpointSequence||change.id!==change.payload?.id)throw new Error('snapshot-history-gap');
    const record={entity:change.entity,payload:change.payload,sequence:change.sequence};validateSnapshotRecord(record,managerScope);
    const encoded=canonical(change.payload),raw=canonical(change);sourceBytes+=Buffer.byteLength(raw);changeCount++;
    if(changeCount>maxChanges||sourceBytes>maxBytes)throw new Error('snapshot-source-limit');
    const previous=get.get(change.entity,change.id);
    if(previous){
     if(change.entity!=='submission')throw new Error('snapshot-immutable-rewrite');
     const old=JSON.parse(previous.payload),omitReview=p=>Object.fromEntries(Object.entries(p).filter(([key])=>!['status','approvedUnitMinor','reviewNote'].includes(key)));
     if(old.status!=='pending'||!['approved','rejected'].includes(change.payload.status)||canonical(omitReview(old))!==canonical(omitReview(change.payload)))throw new Error('snapshot-submission-rewrite');
    }else if(++recordCount>L.maxRecords)throw new Error('snapshot-source-limit');
    save.run(change.entity,change.id,change.sequence,encoded);sequence=change.sequence;feedDigest.update(raw+'\n');documentHashesDigest.update(snapshotHash(raw)+'\n');
   }
   if(sequence!==scope.checkpointSequence)throw new Error('snapshot-history-gap');sourceFeedSha256=feedDigest.digest('hex');sourceDocumentHashesSha256=documentHashesDigest.digest('hex');sealed=true;sealedProjections.add(projection);if(scope.role==='manager')verifiedManagerProjections.add(projection);
   return {checkpointSequence:sequence,sourceRecords:recordCount,sourceChanges:changeCount,sourceBytes};
   }catch(error){failed=true;throw error;}
  },
  async *records(){
   for(const row of fullRecords()){
    if(scope.role==='manager'){yield row;continue;}
    if(row.entity==='party'){
     const p=row.payload,payload={id:p.id,tenantId:scope.tenantId,name:p.name,kind:p.kind,phone:p.phone??'',favorite:p.favorite??false,revision:p.revision??1};
     const projected={...row,payload};validateSnapshotRecord(projected,scope);yield projected;
    }else if(row.entity==='submission'&&row.payload.creatorUid===scope.uid){validateSnapshotRecord(row,scope);yield row;}
   }
  },
  async *iterateFullRecords(){if(scope.role!=='manager')throw new Error('snapshot-projection-denied');for(const row of fullRecords())yield {...row,id:row.payload.id};},
  async *sourceChanges(){if(scope.role!=='manager')throw new Error('snapshot-projection-denied');if(destroyed||!sealed)throw new Error('snapshot-source-not-sealed');for(const row of db.prepare('SELECT entity,id,sequence,payload FROM records ORDER BY sequence').iterate())yield {...row,payload:JSON.parse(row.payload)};},
  destroy,
 });
 return projection;
}
