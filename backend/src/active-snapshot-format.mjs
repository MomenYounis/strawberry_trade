import {createHash} from 'node:crypto';
import {canonical,id,integer,object,keys,text,isoDate,entry,directory} from './validation.mjs';

export const ACTIVE_SNAPSHOT_LIMITS=Object.freeze({pageBytes:65_536,maxPageBytes:66_560,maxRecordBytes:24_000,
  maxPages:4096,maxRecords:500_000,maxTotalBytes:268_435_456,maxManifestBytes:1_048_576});
export const compareCodeUnits=(a,b)=>a<b?-1:a>b?1:0;
export const snapshotHash=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonical(value)).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const headerKeys=['format','version','syncProtocolVersion','snapshotId','tenantId','role','uid','membershipEpoch','checkpointSequence','historyFloor','pageCount','recordCount','contentSha256'];
const scopeKeys=['snapshotId','tenantId','role','uid','membershipEpoch','checkpointSequence','historyFloor'];
function exact(value,fields){object(value);const names=Object.keys(value);if(names.length!==fields.length||names.some(key=>!fields.includes(key)))throw new Error('invalid-snapshot-schema');}
export function safeSnapshotJson(value,depth=0,counter={nodes:0}){
 if(depth>20||++counter.nodes>200_000)throw new Error('snapshot-json-limit');
 if(value===null||typeof value==='boolean'||typeof value==='string')return;
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new Error('snapshot-unsafe-number');return;}
 if(!value||typeof value!=='object'||(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype))throw new Error('invalid-snapshot-json');
 if(Array.isArray(value)&&(Object.keys(value).length!==value.length||Object.keys(value).some((key,index)=>key!==String(index))))throw new Error('invalid-snapshot-json');
 for(const [key,child] of Object.entries(value)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('invalid-snapshot-property');safeSnapshotJson(child,depth+1,counter);}
}
export function snapshotScope(scope){
 exact(scope,scopeKeys);id(scope.snapshotId);id(scope.tenantId);id(scope.uid);
 if(!['manager','employee'].includes(scope.role))throw new Error('invalid-snapshot-role');
 integer(scope.membershipEpoch,1,Number.MAX_SAFE_INTEGER);integer(scope.checkpointSequence,0,Number.MAX_SAFE_INTEGER);
 integer(scope.historyFloor,0,scope.checkpointSequence);return scope;
}
export function scopeFromHeader(header){return Object.fromEntries(scopeKeys.map(key=>[key,header[key]]));}
export function validateSnapshotHeader(header,expected={}){
 exact(header,headerKeys);safeSnapshotJson(header);snapshotScope(scopeFromHeader(header));
 if(header.format!=='active_snapshot'||header.version!==1||header.syncProtocolVersion!==2)throw new Error('unsupported-active-snapshot');
 integer(header.pageCount,0,ACTIVE_SNAPSHOT_LIMITS.maxPages);integer(header.recordCount,0,ACTIVE_SNAPSHOT_LIMITS.maxRecords);
 if(typeof header.contentSha256!=='string'||!hashPattern.test(header.contentSha256)||(header.pageCount===0)!==(header.recordCount===0)||header.pageCount>header.recordCount||header.recordCount>header.checkpointSequence||
   (header.role==='manager'&&(header.checkpointSequence===0)!==(header.recordCount===0)))throw new Error('invalid-snapshot-counts');
 for(const [key,value]of Object.entries(expected))if(!Object.hasOwn(header,key)||header[key]!==value)throw new Error('wrong-snapshot-scope');
 return header;
}
export function validateSnapshotRecord(record,scope){
 exact(record,['entity','payload','sequence']);safeSnapshotJson(record);integer(record.sequence,1,scope.checkpointSequence);
 if(Buffer.byteLength(canonical(record))>ACTIVE_SNAPSHOT_LIMITS.maxRecordBytes)throw new Error('snapshot-record-limit');
 const p=object(record.payload);id(p.id);if(p.tenantId!==scope.tenantId)throw new Error('wrong-snapshot-tenant');
 if(scope.role==='employee'){
  if(record.entity==='party'){
   exact(p,['id','tenantId','name','kind','phone','favorite','revision']);id(p.id);text(p.name,160);text(p.phone,40,true);
   if(!['merchant','supplier'].includes(p.kind)||typeof p.favorite!=='boolean')throw new Error('invalid-snapshot-party');integer(p.revision,1,Number.MAX_SAFE_INTEGER);return record;
  }
  if(record.entity!=='submission'||p.creatorUid!==scope.uid)throw new Error('snapshot-projection-denied');
 }
 if(record.entity==='entry'){
  const {submittedByEmployeeId,originalBusinessDate,correctionOfOperationId,...fields}=p;
  entry(fields,{allowReturnResidual:true});if(p.creatorUid!==undefined)id(p.creatorUid);
  if(submittedByEmployeeId!==undefined)id(submittedByEmployeeId);
  if((originalBusinessDate===undefined)!==(correctionOfOperationId===undefined))throw new Error('invalid-snapshot-correction');
  if(originalBusinessDate!==undefined){isoDate(originalBusinessDate);id(correctionOfOperationId);if(originalBusinessDate>=p.date)throw new Error('invalid-snapshot-correction');}
 }else if(['party','employee','salary_term'].includes(record.entity))directory(record.entity,p,scope.tenantId);
 else if(record.entity==='submission'){
  keys(p,['id','tenantId','creatorUid','employeeId','kind','date','partyId','partyName','qtyMilli','grade','unit','originalId','amountMinor','note','category','status','recordedByUid','recordedAtMs','approvedUnitMinor','reviewNote']);
  id(p.creatorUid);id(p.employeeId);id(p.recordedByUid);isoDate(p.date);integer(p.recordedAtMs,0,8_640_000_000_000_000);
  if(p.recordedByUid!==p.creatorUid||!['pending','approved','rejected'].includes(p.status)||!['delivery','purchase_delivery','sale_return','purchase_return','expense_business'].includes(p.kind))throw new Error('invalid-snapshot-submission');
  for(const key of ['qtyMilli','amountMinor','approvedUnitMinor'])if(p[key]!==undefined)integer(p[key]);
  for(const [key,max]of [['note',1000],['reviewNote',1000],['partyName',160],['grade',80],['unit',40],['category',80]])if(p[key]!==undefined)text(p[key],max,true);
  for(const key of ['partyId','originalId'])if(p[key])id(p[key]);
  if(p.kind==='expense_business'){
   integer(p.amountMinor,1);if((p.qtyMilli??0)!==0||p.partyId||p.partyName||p.grade||p.unit||!p.category)throw new Error('invalid-snapshot-submission');
  }else{
   id(p.partyId);integer(p.qtyMilli,1);text(p.unit,40);text(p.grade,80);
   if(p.kind==='purchase_delivery')integer(p.amountMinor??0,0,1_000_000_000);else if((p.amountMinor??0)!==0)throw new Error('invalid-snapshot-submission');
   if(p.category)throw new Error('invalid-snapshot-submission');
  }
  if(!['sale_return','purchase_return'].includes(p.kind)&&p.originalId)throw new Error('invalid-snapshot-submission');
  if((p.approvedUnitMinor!==undefined&&(p.kind!=='purchase_delivery'||p.status!=='approved'))||(p.status==='pending'&&(p.reviewNote!==undefined||p.approvedUnitMinor!==undefined)))throw new Error('invalid-snapshot-submission');
 }else if(record.entity==='review'){
  keys(p,['id','tenantId','submissionId','decision','note','reviewerUid','reviewedAtMs','entryId']);id(p.submissionId);id(p.reviewerUid);integer(p.reviewedAtMs,0,8_640_000_000_000_000);text(p.note??'',1000,true);
  if(!['approved','rejected'].includes(p.decision))throw new Error('invalid-snapshot-review');if(p.decision==='approved')id(p.entryId);else if(p.entryId!==undefined)throw new Error('invalid-snapshot-review');
 }else throw new Error('unsupported-snapshot-entity');
 return record;
}
export const snapshotRecordKey=record=>`${record.entity}/${String(record.sequence).padStart(16,'0')}/${record.payload.id}`;
export function pageDescriptor(page){return {index:page.index,sha256:page.sha256,recordCount:page.records.length};}
export function snapshotContentHash(descriptors){return snapshotHash(descriptors.map(({index,sha256,recordCount})=>({index,sha256,recordCount})));}
export function validateSnapshotPage(page,header,index){
 exact(page,['snapshotId','index','records','sha256']);safeSnapshotJson(page);
 integer(index,0,header.pageCount-1);
 if(page.snapshotId!==header.snapshotId||page.index!==index||!Array.isArray(page.records)||!page.records.length||page.records.length>ACTIVE_SNAPSHOT_LIMITS.maxRecords)throw new Error('wrong-snapshot-page');
 if(Buffer.byteLength(canonical(page.records))>ACTIVE_SNAPSHOT_LIMITS.pageBytes||Buffer.byteLength(canonical(page))>ACTIVE_SNAPSHOT_LIMITS.maxPageBytes)throw new Error('snapshot-page-limit');
 let previous=null;for(const record of page.records){validateSnapshotRecord(record,header);const key=snapshotRecordKey(record);if(previous!==null&&compareCodeUnits(previous,key)>=0)throw new Error('snapshot-record-order');previous=key;}
 if(typeof page.sha256!=='string'||!hashPattern.test(page.sha256)||snapshotHash(page.records)!==page.sha256)throw new Error('snapshot-page-integrity');return page;
}
export function parseSnapshotBytes(bytes,maxBytes){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>maxBytes)throw new Error('snapshot-byte-limit');
 let raw,value;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(raw);}catch{throw new Error('invalid-snapshot-json');}
 safeSnapshotJson(value);if(canonical(value)!==raw)throw new Error('noncanonical-snapshot-json');return value;
}
