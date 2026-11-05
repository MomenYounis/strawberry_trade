// Private Node, read-only recovery capture. No ADC, Admin SDK or provider writes.
// Every REST read (including missing-parent inventories) carries one readTime.
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {TENANT_RECOVERY_COLLECTIONS} from './tenant-recovery-quarantine.mjs';

export const FIRESTORE_RECOVERY_LIMITS=Object.freeze({records:500_000,recordBytes:750_000,
 responseBytes:1_048_576,totalBytes:536_870_912,wireBytes:1_073_741_824,requests:1_100_000,pageRecords:20,
 tokenBytes:4096,depth:16,fieldNodes:100_000,requestTimeoutMs:30_000,durationMs:1_800_000});
const branded=new WeakSet(),proofs=new WeakSet(),hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const allowed=Object.freeze(['$root',...TENANT_RECOVERY_COLLECTIONS]);
const fail=reason=>{throw Error('firestore-recovery-'+reason);};
const object=value=>{if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('schema');return value;};
const only=(value,keys)=>{object(value);if(Object.keys(value).some(key=>!keys.includes(key)))fail('schema');};
export function freezeRecoveryValue(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freezeRecoveryValue(child);Object.freeze(value);}return value;}
function timestamp(value,{microseconds=false}={}){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value))fail('timestamp');
 const [whole,fraction='']=value.slice(0,-1).split('.'),ms=Date.parse(whole+'Z');
 if(!Number.isSafeInteger(ms)||new Date(ms).toISOString().slice(0,19)!==whole||microseconds&&fraction.length>6)fail('timestamp');
 return BigInt(ms)*1_000_000n+BigInt(fraction.padEnd(9,'0'));
}
export function recoveryTimestampNanoseconds(value,options){return timestamp(value,options);}
function fieldName(key){if(!key||Buffer.byteLength(key)>1500||['__proto__','constructor','prototype'].includes(key))fail('field-name');}
// This application persists JSON integers, not lossy doubles/Timestamps/refs.
// Unsupported Firestore types fail closed rather than being silently converted.
export function decodeRecoveryFields(fields,{maxDepth=FIRESTORE_RECOVERY_LIMITS.depth,maxNodes=FIRESTORE_RECOVERY_LIMITS.fieldNodes}={}){
 integer(maxDepth,1,FIRESTORE_RECOVERY_LIMITS.depth);integer(maxNodes,1,FIRESTORE_RECOVERY_LIMITS.fieldNodes);let nodes=0;
 function decode(value,depth){
  if(++nodes>maxNodes||depth>maxDepth)fail('field-limit');object(value);const keys=Object.keys(value);if(keys.length!==1)fail('typed-value');
  const key=keys[0],v=value[key];
  if(key==='nullValue'&&v===null)return null;
  if(key==='booleanValue'&&typeof v==='boolean')return v;
  if(key==='stringValue'&&typeof v==='string'){if(Buffer.byteLength(v)>FIRESTORE_RECOVERY_LIMITS.recordBytes)fail('string-limit');return v;}
  if(key==='integerValue'&&typeof v==='string'&&/^(0|-?[1-9]\d*)$/.test(v)&&v.length<=17){const n=Number(v);if(Number.isSafeInteger(n)&&String(n)===v)return n;fail('unsafe-integer');}
  if(key==='arrayValue'){only(v,['values']);const a=v.values??[];if(!Array.isArray(a)||a.length>maxNodes-nodes)fail('field-limit');return a.map(child=>decode(child,depth+1));}
  if(key==='mapValue'){only(v,['fields']);return map(v.fields??{},depth+1);}
  fail('unsupported-field-type');
 }
 function map(value,depth){object(value);const result={};for(const [key,child]of Object.entries(value)){fieldName(key);result[key]=decode(child,depth);}return result;}
 return map(fields,0);
}
export function isFirestoreRecoverySource(value){return branded.has(value);}
export function isFirestoreRecoveryProof(value){return proofs.has(value);}

export function createFirestoreRecoverySource({projectId,databaseId,tenantId,readTime,accessToken,
 endpoint='https://firestore.googleapis.com',allowLoopbackForTests=false,pitrCapability=null,
 now=Date.now,monotonicNow=()=>performance.now(),pageSize=1,limits={}}){
 if(typeof projectId!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)||
  typeof databaseId!=='string'||!(/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)||databaseId==='(default)'))fail('database-identity');
 id(tenantId);integer(pageSize,1,FIRESTORE_RECOVERY_LIMITS.pageRecords);
 if(typeof accessToken!=='function'||typeof now!=='function'||typeof monotonicNow!=='function')fail('explicit-token-and-clock-required');
 let lastMonotonic=-Infinity;
 function elapsedClock(){const value=monotonicNow();if(!Number.isFinite(value)||value<0||value<lastMonotonic)fail('monotonic-clock');lastMonotonic=value;return value;}
 const base=new URL(endpoint),local=base.protocol==='http:'&&['127.0.0.1','[::1]'].includes(base.hostname)&&!!base.port;
 if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
  !(base.origin==='https://firestore.googleapis.com'||local&&allowLoopbackForTests===true&&projectId.startsWith('demo-')))fail('endpoint');
 const selected={...FIRESTORE_RECOVERY_LIMITS};only(limits,Object.keys(selected));
 for(const [key,value]of Object.entries(limits)){integer(value,1,selected[key]);selected[key]=value;}
 if(pageSize>selected.pageRecords)fail('page-size');
 const capturedNs=timestamp(readTime,{microseconds:true});
 let pitr=false;
 if(pitrCapability!==null){
  only(pitrCapability,['projectId','databaseId','enabled','earliestVersionTime','verifiedAtMs']);
  if(pitrCapability.projectId!==projectId||pitrCapability.databaseId!==databaseId||pitrCapability.enabled!==true||
   !Number.isSafeInteger(pitrCapability.verifiedAtMs)||pitrCapability.verifiedAtMs>now()||now()-pitrCapability.verifiedAtMs>3_600_000||
   capturedNs<timestamp(pitrCapability.earliestVersionTime,{microseconds:true}))fail('pitr-capability');
  pitr=true;pitrCapability=structuredClone(pitrCapability);
 }
 function live(){
  const current=now();if(!Number.isSafeInteger(current))fail('clock');const elapsed=BigInt(current)*1_000_000n-capturedNs;
  if(elapsed<0n)fail('future-read-time');
  if(elapsed>=3_600_000_000_000n&&!(pitr&&elapsed<604_800_000_000_000n&&capturedNs%60_000_000_000n===0n))fail('read-time-expired');
 }
 live();
 const prefix=`projects/${projectId}/databases/${databaseId}/documents`,root=`${prefix}/tenants/${tenantId}`;
 const context=freezeRecoveryValue({projectId,databaseId,tenantId,readTime});let running=false;
 async function capture({writeRecord}){
  if(typeof writeRecord!=='function'||running)fail('capture-consumer');running=true;
  const started=elapsedClock();let requests=0,records=0,bytes=0,wireBytes=0;const digest=createHash('sha256'),counts=Object.fromEntries(allowed.map(c=>[c,0]));
  async function request(path,{query={},body}={}){
   live();if(++requests>selected.requests)fail('request-limit');
   const token=await accessToken();live();if(typeof token!=='string'||!token.length||token.length>32_768||/[\s\x00-\x1f\x7f]/.test(token))fail('access-token');
   const url=new URL('/v1/'+path,base);if(!body)url.search=new URLSearchParams({...query,readTime}).toString();
   const elapsedNs=BigInt(now())*1_000_000n-capturedNs,windowNs=pitr&&capturedNs%60_000_000_000n===0n?604_800_000_000_000n:3_600_000_000_000n;
   const remaining=Math.min(selected.durationMs-(elapsedClock()-started),Number((windowNs-elapsedNs)/1_000_000n));
   if(remaining<1)fail('capture-deadline');
   const response=await fetch(url,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify({...body,readTime})}:{}),redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.floor(Math.min(selected.requestTimeoutMs,remaining))))});
   if(!response.ok){await response.body?.cancel().catch(()=>{});fail(response.status===400||response.status===412?'provider-consistency-rejected':'http-'+response.status);}
   const reader=response.body?.getReader();if(!reader)fail('empty-response');const chunks=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;wireBytes+=part.value.length;if(size>selected.responseBytes)fail('response-limit');if(wireBytes>selected.wireBytes)fail('wire-limit');if(elapsedClock()-started>=selected.durationMs)fail('capture-deadline');chunks.push(Buffer.from(part.value));}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   live();let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('response-json');}return object(result);
  }
  function nextToken(page,current){const value=page.nextPageToken??'';if(typeof value!=='string'||Buffer.byteLength(value)>selected.tokenBytes||value&&value===current)fail('page-token');return value;}
  async function children(path,{nested=false}={}){
   const ids=new Set(),tokens=new Set();let pageToken='';
   do{
    const page=await request(path+':listCollectionIds',{body:{pageSize:nested?1:20,...(pageToken?{pageToken}:{})}});
    only(page,['collectionIds','nextPageToken']);const found=page.collectionIds??[];
    if(!Array.isArray(found)||found.length>(nested?1:20))fail('collection-page');
    for(const name of found){if(nested)fail('nested-collection');if(!TENANT_RECOVERY_COLLECTIONS.includes(name))fail('unknown-collection');if(ids.has(name))fail('duplicate-collection');ids.add(name);}
    pageToken=nextToken(page,pageToken);if(pageToken&&tokens.has(pageToken))fail('page-token');tokens.add(pageToken);
    if(tokens.size>TENANT_RECOVERY_COLLECTIONS.length+1)fail('collection-page-limit');
   }while(pageToken);
   return [...ids].sort();
  }
  function decodeDocument(doc,collection){
   only(doc,['name','fields','createTime','updateTime']);
   const expected=collection==='$root'?root:root+'/'+collection+'/',name=doc.name;
   if(typeof name!=='string'||(collection==='$root'?name!==expected:!name.startsWith(expected)))fail('document-path');
   const documentId=collection==='$root'?tenantId:name.slice(expected.length);id(documentId);
   if(!doc.createTime&&!doc.updateTime&&!doc.fields)fail('orphan-document');
   if(timestamp(doc.createTime)>timestamp(doc.updateTime)||timestamp(doc.updateTime)>capturedNs)fail('document-time');
   const payload=decodeRecoveryFields(doc.fields??{},{maxDepth:selected.depth,maxNodes:selected.fieldNodes});
   if(Object.hasOwn(payload,'tenantId')&&payload.tenantId!==tenantId)fail('tenant-mismatch');
   const row={collection,id:documentId,payload,source:{name,createTime:doc.createTime,updateTime:doc.updateTime}};
   if(Buffer.byteLength(canonical(row))>selected.recordBytes)fail('record-limit');return row;
  }
  async function accept(row){
   const raw=canonical(row);if(++records>selected.records||(bytes+=Buffer.byteLength(raw))>selected.totalBytes)fail('source-limit');
   counts[row.collection]++;digest.update(raw).update('\n');await writeRecord(freezeRecoveryValue(row));live();if(elapsedClock()-started>=selected.durationMs)fail('capture-deadline');
  }
  try{
   const initial=decodeDocument(await request(root),'$root'),collections=await children(root);await accept(initial);
   for(const collection of collections){
    let pageToken='',last='',pages=0;
    do{
     if(++pages>selected.records+1)fail('document-page-limit');
     const page=await request(root+'/'+collection,{query:{showMissing:'true',pageSize:String(pageSize),...(pageToken?{pageToken}:{})}});
     only(page,['documents','nextPageToken']);const docs=page.documents??[];if(!Array.isArray(docs)||docs.length>pageSize)fail('document-page');
     for(const doc of docs){
      const row=decodeDocument(doc,collection);if(row.id<=last)fail('document-order');last=row.id;
      await children(doc.name,{nested:true});await accept(row);
     }
     const next=nextToken(page,pageToken);if(next&&!docs.length)fail('empty-continuation-page');pageToken=next;
    }while(pageToken);
   }
   if(canonical(decodeDocument(await request(root),'$root'))!==canonical(initial)||canonical(await children(root))!==canonical(collections))fail('fixed-time-drift');
   live();const proof=freezeRecoveryValue({kind:'firestore-rest-fixed-read-time-v1',...context,readTimeCapability:pitr?'explicit-pitr':'one-hour',
    productionSourceConsistencyAccepted:false,localTransportFixture:local,collections:allowed,counts,records,bytes,wireBytes,requests,documentsSha256:digest.digest('hex'),
    inventorySha256:hash(allowed),rootUpdateTime:initial.source.updateTime});proofs.add(proof);return proof;
  }finally{running=false;}
 }
 const result=Object.freeze({kind:'firestore-rest-fixed-read-time-v1',context,capture});branded.add(result);return result;
}
