// Private, synthetic-only server-state recovery preparation. Never imported by
// the Worker and never activates a tenant, Auth account, license or device.
import {createHash,createHmac,createCipheriv,createDecipheriv,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from './demo-operator.mjs';

export const TENANT_RECOVERY_COLLECTIONS=Object.freeze([
 'archiveRuns','audit','challenges','changes','conflicts','devices','employeeAccounts',
 'employeeChanges','employees','entries','invitations','lateCorrectionLocks',
 'lateOperations','members','operations','parties','returnCounters','reversalLocks',
 'reviewLocks','reviews','salaryLocks','salaryTerms','sessions','shipmentCounters','submissions',
]);
export const TENANT_RECOVERY_BLOCKERS=Object.freeze([
 'production-consistent-source-adapter-unavailable','auth-provider-backup-and-reenrollment-required',
 'top-level-operator-history-backup-required','archive-and-snapshot-object-copies-required',
 'independent-storage-and-key-recovery-unaccepted','production-activation-not-implemented',
]);
export const TENANT_RECOVERY_LIMITS=Object.freeze({records:500_000,recordBytes:750_000,
 pageRecords:20,pageBytes:1_048_576,pages:25_001,totalBytes:536_870_912,manifestBytes:8_388_608});
const collections=['$root',...TENANT_RECOVERY_COLLECTIONS],hex=/^[a-f0-9]{64}$/;
const sources=new WeakSet(),authenticated=new WeakSet();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=value=>Buffer.from(canonical(value));
const clone=value=>JSON.parse(canonical(value));
function schema(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw Error('recovery-schema');}
function json(value,depth=0,maxDepth=20){
 if(depth>maxDepth)throw Error('recovery-depth');
 if(value===null||typeof value==='boolean')return;
 if(typeof value==='string'){if(Buffer.byteLength(value)>TENANT_RECOVERY_LIMITS.recordBytes)throw Error('recovery-string-limit');return;}
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('recovery-unsafe-number');return;}
 if(!value||typeof value!=='object'||(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype))throw Error('recovery-unsupported-firestore-type');
 for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw Error('recovery-property');json(child,depth+1,maxDepth);}
}
function parse(data,limit){
 if(!(data instanceof Uint8Array)||data.byteLength>limit)throw Error('recovery-byte-limit');
 let value,raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(data);value=JSON.parse(raw);}catch{throw Error('recovery-json');}
 json(value);if(canonical(value)!==raw)throw Error('recovery-noncanonical');return value;
}
function contextCheck(c){
 schema(c,['tenantId','imageId','sourceProjectId','keyId','createdAtMs']);
 for(const key of ['tenantId','imageId','keyId'])id(c[key]);
 if(c.sourceProjectId!==DEMO_PROJECT_ID)throw Error('synthetic-recovery-source-required');
 integer(c.createdAtMs,0,Number.MAX_SAFE_INTEGER);return c;
}
function recordCheck(r,c){
 schema(r,['collection','id','payload']);if(!collections.includes(r.collection))throw Error('unknown-recovery-collection');id(r.id);
 if(r.collection==='$root'&&r.id!==c.tenantId)throw Error('recovery-tenant-mismatch');
 if(!r.payload||Object.getPrototypeOf(r.payload)!==Object.prototype)throw Error('recovery-document-schema');
 json(r.payload,0,16);if(Object.hasOwn(r.payload,'tenantId')&&r.payload.tenantId!==c.tenantId)throw Error('recovery-tenant-mismatch');
 if(bytes(r).byteLength>TENANT_RECOVERY_LIMITS.recordBytes)throw Error('recovery-record-limit');
 return r.collection+'/'+r.id;
}
function derive(master,c,purpose){
 if(!(master instanceof Uint8Array)||master.byteLength!==32)throw Error('recovery-key-required');
 return Buffer.from(hkdfSync('sha256',master,bytes(c),Buffer.from('strawberry-tenant-recovery-v1/'+purpose),32));
}
function mac(body,master){const key=derive(master,body.context,'manifest');try{return createHmac('sha256',key).update(bytes(body)).digest('hex');}finally{key.fill(0);}}
function seal(plain,master,c,index){
 const key=derive(master,c,'page/'+index),nonce=randomBytes(12);
 try{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(bytes({format:'tenant-recovery-v1',context:c,index}));return Buffer.concat([nonce,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);}finally{key.fill(0);}
}
function unseal(cipher,master,c,index){
 const key=derive(master,c,'page/'+index);
 try{const decipher=createDecipheriv('aes-256-gcm',key,cipher.subarray(0,12));decipher.setAAD(bytes({format:'tenant-recovery-v1',context:c,index}));decipher.setAuthTag(cipher.subarray(-16));return Buffer.concat([decipher.update(cipher.subarray(12,-16)),decipher.final()]);}
 catch{throw Error('recovery-authentication-failed');}finally{key.fill(0);}
}
function boundary(db,environment){
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,environment);
 if(db.projectId!==DEMO_PROJECT_ID)throw Error('synthetic-recovery-database-required');
}
const blankCounts=()=>Object.fromEntries(collections.map(name=>[name,0]));
// SDK queries omit nonexistent parent documents that still own subcollections.
// A projected, showMissing REST inventory catches those orphans without loading
// an unbounded listDocuments() array or full document payloads into memory.
async function inventoryRequest(environment,path,{query='',body,maxBytes=65_536}={}){
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,environment);
 const response=await fetch(`http://${environment.FIRESTORE_EMULATOR_HOST}/v1/projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${path}${query}`,{
  method:body?'POST':'GET',headers:{authorization:'Bearer owner',...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10_000)});
 const reader=response.body.getReader(),parts=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('recovery-inventory-response-limit');parts.push(Buffer.from(value));}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(!response.ok)throw Error('recovery-inventory-request-failed');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw Error('recovery-inventory-json');}
}
async function childCollections(environment,path,limit){
 const page=await inventoryRequest(environment,path+':listCollectionIds',{body:{pageSize:limit}});
 if(!Array.isArray(page.collectionIds??[])||(page.collectionIds??[]).length>limit)throw Error('recovery-collection-inventory-limit');
 if(page.nextPageToken)throw Error(limit===1?'nested-recovery-collection-unsupported':'recovery-collection-inventory-limit');
 return page.collectionIds??[];
}
async function* inventoryDocuments(db,environment,parent,name,pageSize=50){
 // The local Firestore emulator may return full fields despite a projection.
 // Fetch at most one inventory document, then enforce an independent response
 // byte cap before JSON decoding or the SDK read. This bounds both paths even
 // when a single source document is near Firestore's own document-size limit.
 // showMissing remains necessary to discover orphaned nested collections.
 pageSize=Math.min(pageSize,1);
 let pageToken='',last='',pages=0;
 do{
  if(++pages>Math.ceil(TENANT_RECOVERY_LIMITS.records/pageSize)+1)throw Error('recovery-document-inventory-page-limit');
  const query=new URLSearchParams({pageSize:String(pageSize),showMissing:'true','mask.fieldPaths':'strawberryInventoryNamesOnlyProjection',...(pageToken?{pageToken}:{})});
  const page=await inventoryRequest(environment,parent+'/'+name,{query:'?'+query,maxBytes:TENANT_RECOVERY_LIMITS.pageBytes});
  if(!Array.isArray(page.documents??[])||(page.documents??[]).length>pageSize)throw Error('recovery-document-inventory-limit');
  const prefix=`projects/${DEMO_PROJECT_ID}/databases/(default)/documents/`,paths=[];
  for(const item of page.documents??[]){
   if(typeof item.name!=='string'||!item.name.startsWith(prefix+parent+'/'+name+'/'))throw Error('recovery-document-inventory-path');
   const path=item.name.slice(prefix.length),docId=path.slice((parent+'/'+name+'/').length);id(docId);
   if(path<=last)throw Error('recovery-document-inventory-order');last=path;paths.push(path);
  }
  if(paths.length){
   const docs=await db.getAll(...paths.map(path=>db.doc(path)));
   for(const doc of docs){
    if((await childCollections(environment,doc.ref.path,1)).length)throw Error('nested-recovery-collection-unsupported');
    if(doc.exists)yield doc;
   }
  }
  const next=page.nextPageToken??'';if(typeof next!=='string'||next.length>4096||next===pageToken&&next)throw Error('recovery-document-inventory-token');
  pageToken=next;
 }while(pageToken);
}

// Explicitly synthetic quiescent source only. A repeated complete scan detects
// drift; this is NOT a production point-in-time snapshot guarantee. Production
// capture requires a separate accepted provider-consistent source adapter.
export async function createSyntheticTenantRecoverySource({db,tenantId,environment=process.env,pageSize=50}){
 boundary(db,environment);id(tenantId);integer(pageSize,1,100);
 const root=db.doc('tenants/'+tenantId),context={tenantId};
 async function* scan(){
  boundary(db,environment);
  const found=await childCollections(environment,root.path,TENANT_RECOVERY_COLLECTIONS.length+1);
  if(found.some(name=>!TENANT_RECOVERY_COLLECTIONS.includes(name)))throw Error('unknown-recovery-collection');
  const snapshot=await root.get();if(!snapshot.exists)throw Error('recovery-source-tenant-missing');
  yield {collection:'$root',id:tenantId,payload:snapshot.data()};
  for(const name of TENANT_RECOVERY_COLLECTIONS)for await(const doc of inventoryDocuments(db,environment,root.path,name,pageSize))yield {collection:name,id:doc.id,payload:doc.data()};
 }
 async function summary(){
  const digest=createHash('sha256'),counts=blankCounts();let size=0,total=0;
  for await(const row of scan()){
   recordCheck(row,context);const raw=bytes(row);digest.update(raw).update('\n');counts[row.collection]++;size+=raw.length;total++;
   if(total>TENANT_RECOVERY_LIMITS.records||size>TENANT_RECOVERY_LIMITS.totalBytes)throw Error('recovery-source-limit');
  }
  return {counts,records:total,bytes:size,sha256:digest.digest('hex')};
 }
 const expected=await summary(),proof=Object.freeze({kind:'synthetic-quiescent-repeated-scan-v1',
  productionSourceConsistencyAccepted:false,inventorySha256:hash(bytes(collections)),documentsSha256:expected.sha256});
 const source=Object.freeze({tenantId,proof,async *records(){
  const digest=createHash('sha256'),counts=blankCounts();let total=0,size=0;
  for await(const row of scan()){recordCheck(row,context);const raw=bytes(row);digest.update(raw).update('\n');counts[row.collection]++;size+=raw.length;total++;yield row;}
  const actual={counts,records:total,bytes:size,sha256:digest.digest('hex')};
  if(canonical(actual)!==canonical(expected)||canonical(await summary())!==canonical(expected))throw Error('synthetic-recovery-source-changed');
 }});sources.add(source);return source;
}

// A test storage implementation, never production storage acceptance.
export class SyntheticTenantRecoveryStorage{
 constructor({maxBytes=32*1024*1024}={}){integer(maxBytes,1,TENANT_RECOVERY_LIMITS.totalBytes);this.maxBytes=maxBytes;this.objects=new Map();this.kind='synthetic-tenant-recovery';this.productionDurabilityAccepted=false;}
 async putImmutable(key,data){
  if(typeof key!=='string'||!/^tenant-recovery\/v1\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/(pages|manifests)\/[a-f0-9]{64}$/.test(key)||!key.endsWith('/'+hash(data))||data.byteLength>TENANT_RECOVERY_LIMITS.manifestBytes)throw Error('recovery-object-identity');
  const old=this.objects.get(key);if(old&&!old.equals(Buffer.from(data)))throw Error('recovery-immutable-conflict');
  if(!old&&[...this.objects.values()].reduce((n,v)=>n+v.length,0)+data.length>this.maxBytes)throw Error('synthetic-recovery-storage-limit');
  this.objects.set(key,Buffer.from(data));return {key};
 }
 async read(key,{maxBytes}){integer(maxBytes,1,TENANT_RECOVERY_LIMITS.manifestBytes);const value=this.objects.get(key);if(!value)throw Error('recovery-object-missing');if(value.length>maxBytes)throw Error('recovery-download-limit');return Buffer.from(value);}
}

export async function exportSyntheticTenantRecoveryImage({source,storage,masterKey,context,pageBytes=65_536}){
 context=clone(contextCheck(context));integer(pageBytes,1024,TENANT_RECOVERY_LIMITS.pageBytes);
 if(!sources.has(source)||source.tenantId!==context.tenantId)throw Error('accepted-recovery-source-adapter-required');
 const prefix=`tenant-recovery/v1/${context.tenantId}/${context.imageId}`,pages=[],counts=blankCounts(),digest=createHash('sha256');
 let rows=[],size=2,totalBytes=0,total=0,last='';
 async function flush(){
  if(!rows.length)return;if(pages.length>=TENANT_RECOVERY_LIMITS.pages)throw Error('recovery-page-limit');
  const plain=bytes(rows),index=pages.length,cipher=seal(plain,masterKey,context,index),sha256=hash(cipher),key=prefix+'/pages/'+sha256;
  await storage.putImmutable(key,cipher);pages.push({index,key,records:rows.length,plainBytes:plain.length,cipherBytes:cipher.length,plainSha256:hash(plain),cipherSha256:sha256});plain.fill(0);rows=[];size=2;
 }
 for await(const row of source.records()){
  const path=recordCheck(row,context),raw=bytes(row);
  if(last&&path<=last)throw Error('recovery-record-order');last=path;
  if(rows.length&&(rows.length===TENANT_RECOVERY_LIMITS.pageRecords||size+raw.length+1>pageBytes))await flush();
  rows.push(row);size+=raw.length+1;total++;totalBytes+=raw.length;counts[row.collection]++;digest.update(raw).update('\n');
  if(total>TENANT_RECOVERY_LIMITS.records||totalBytes>TENANT_RECOVERY_LIMITS.totalBytes)throw Error('recovery-source-limit');
 }
 await flush();
 const body={format:'strawberry-tenant-recovery',version:1,algorithm:'AES-256-GCM/HKDF-SHA256/HMAC-SHA256',context,
  sourceProof:source.proof,collections,counts,recordCount:total,totalPlainRecordBytes:totalBytes,recordsSha256:digest.digest('hex'),
  pages,activationAllowed:false,unresolvedDependencies:TENANT_RECOVERY_BLOCKERS};
 if(body.recordsSha256!==source.proof.documentsSha256)throw Error('recovery-source-proof-mismatch');
 const manifest=bytes({body,mac:mac(body,masterKey)});if(manifest.length>TENANT_RECOVERY_LIMITS.manifestBytes)throw Error('recovery-manifest-limit');
 const manifestSha256=hash(manifest),manifestKey=prefix+'/manifests/'+manifestSha256;
 await storage.putImmutable(manifestKey,manifest);
 return {manifestKey,manifestSha256,recordCount:total,pageCount:pages.length,productionSourceConsistencyAccepted:false,productionDurabilityAccepted:false};
}

export async function readTenantRecoveryManifest({storage,manifestKey,manifestSha256,masterKey,expected}){
 if(!hex.test(manifestSha256))throw Error('recovery-manifest-hash-required');
 const raw=await storage.read(manifestKey,{maxBytes:TENANT_RECOVERY_LIMITS.manifestBytes});
 if(hash(raw)!==manifestSha256)throw Error('recovery-manifest-integrity');
 const envelope=parse(raw,TENANT_RECOVERY_LIMITS.manifestBytes);schema(envelope,['body','mac']);const b=envelope.body;
 schema(b,['format','version','algorithm','context','sourceProof','collections','counts','recordCount','totalPlainRecordBytes','recordsSha256','pages','activationAllowed','unresolvedDependencies']);contextCheck(b.context);
 if(manifestKey!==`tenant-recovery/v1/${b.context.tenantId}/${b.context.imageId}/manifests/${manifestSha256}`)throw Error('recovery-manifest-object-identity');
 if(b.format!=='strawberry-tenant-recovery'||b.version!==1||b.algorithm!=='AES-256-GCM/HKDF-SHA256/HMAC-SHA256'||b.activationAllowed!==false||canonical(b.collections)!==canonical(collections)||canonical(b.unresolvedDependencies)!==canonical(TENANT_RECOVERY_BLOCKERS))throw Error('unsupported-recovery-image');
 schema(b.sourceProof,['kind','productionSourceConsistencyAccepted','inventorySha256','documentsSha256']);
 if(b.sourceProof.kind!=='synthetic-quiescent-repeated-scan-v1'||b.sourceProof.productionSourceConsistencyAccepted!==false||b.sourceProof.inventorySha256!==hash(bytes(collections))||b.sourceProof.documentsSha256!==b.recordsSha256)throw Error('recovery-source-proof');
 schema(b.counts,collections);for(const count of Object.values(b.counts))integer(count,0,TENANT_RECOVERY_LIMITS.records);
 integer(b.recordCount,1,TENANT_RECOVERY_LIMITS.records);integer(b.totalPlainRecordBytes,1,TENANT_RECOVERY_LIMITS.totalBytes);
 if(b.counts.$root!==1||Object.values(b.counts).reduce((n,v)=>n+v,0)!==b.recordCount||!hex.test(b.recordsSha256))throw Error('recovery-inventory');
 if(!Array.isArray(b.pages)||!b.pages.length||b.pages.length>TENANT_RECOVERY_LIMITS.pages)throw Error('recovery-page-limit');
 let recordCount=0,totalBytes=0;
 for(const [index,p]of b.pages.entries()){
  schema(p,['index','key','records','plainBytes','cipherBytes','plainSha256','cipherSha256']);
  if(p.index!==index||!hex.test(p.plainSha256)||!hex.test(p.cipherSha256)||p.key!==`tenant-recovery/v1/${b.context.tenantId}/${b.context.imageId}/pages/${p.cipherSha256}`)throw Error('recovery-page-descriptor');
  integer(p.records,1,TENANT_RECOVERY_LIMITS.pageRecords);integer(p.plainBytes,2,TENANT_RECOVERY_LIMITS.pageBytes);integer(p.cipherBytes,30,TENANT_RECOVERY_LIMITS.pageBytes+28);
  if(p.cipherBytes!==p.plainBytes+28)throw Error('recovery-page-length');recordCount+=p.records;totalBytes+=p.plainBytes;
 }
 if(recordCount!==b.recordCount||totalBytes>TENANT_RECOVERY_LIMITS.totalBytes+2*b.recordCount)throw Error('recovery-page-inventory');
 for(const [key,value]of Object.entries(expected??{}))if(!Object.hasOwn(b.context,key)||b.context[key]!==value)throw Error('wrong-recovery-context');
 if(typeof envelope.mac!=='string'||!hex.test(envelope.mac)||!timingSafeEqual(Buffer.from(envelope.mac,'hex'),Buffer.from(mac(b,masterKey),'hex')))throw Error('recovery-authentication-failed');
 const result=JSON.parse(canonical(b));
 // Freeze recursively before branding; callers cannot mutate authenticated rows.
 const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
 freeze(result);authenticated.add(result);return result;
}

async function readPage({storage,manifest,masterKey,index}){
 if(!authenticated.has(manifest))throw Error('authenticated-recovery-manifest-required');
 integer(index,0,manifest.pages.length-1);const p=manifest.pages[index],cipher=await storage.read(p.key,{maxBytes:p.cipherBytes});
 if(cipher.length!==p.cipherBytes||hash(cipher)!==p.cipherSha256)throw Error('recovery-page-integrity');
 const plain=unseal(cipher,masterKey,manifest.context,index);
 try{if(plain.length!==p.plainBytes||hash(plain)!==p.plainSha256)throw Error('recovery-plaintext-integrity');const rows=parse(plain,TENANT_RECOVERY_LIMITS.pageBytes);if(!Array.isArray(rows)||rows.length!==p.records)throw Error('recovery-page-records');for(const row of rows)recordCheck(row,manifest.context);return rows;}finally{plain.fill(0);}
}
function refs(db,c){const journal=db.doc('tenantRecoveryQuarantine/'+c.imageId);return {journal,root:journal.collection('tenants').doc(c.tenantId)};}
function journalCheck(j,m,manifestSha256){
 schema(j,['format','tenantId','manifestSha256','enabled','activationAllowed','state','nextPage','records','counts','lastPath','unresolvedDependencies']);
 if(j.format!=='tenant-recovery-quarantine-v1'||j.manifestSha256!==manifestSha256||j.tenantId!==m.context.tenantId||j.enabled!==false||j.activationAllowed!==false||!['staging','verified_quarantine'].includes(j.state)||canonical(j.unresolvedDependencies)!==canonical(TENANT_RECOVERY_BLOCKERS))throw Error('recovery-journal-conflict');
 integer(j.nextPage,0,m.pages.length);integer(j.records,0,m.recordCount);schema(j.counts,collections);
 for(const name of collections){integer(j.counts[name],0,m.counts[name]);}
 if(typeof j.lastPath!=='string'||j.lastPath.length>250||Object.values(j.counts).reduce((n,v)=>n+v,0)!==j.records||m.pages.slice(0,j.nextPage).reduce((n,p)=>n+p.records,0)!==j.records||(j.records===0)!==(j.lastPath==='')||(j.state==='verified_quarantine'&&j.nextPage!==m.pages.length))throw Error('recovery-journal-progress');
}

// Every write is under the separate quarantine prefix. The ordinary gateway has
// no route to it. This function has no live-tenant activation or Auth API.
export async function restoreTenantRecoveryStep({db,environment=process.env,storage,masterKey,manifestKey,manifestSha256,expected,afterCommit=async()=>{}}){
 boundary(db,environment);
 if(!expected?.tenantId||!expected?.imageId)throw Error('explicit-recovery-context-required');
 const m=await readTenantRecoveryManifest({storage,masterKey,manifestKey,manifestSha256,expected}),r=refs(db,m.context);
 await db.runTransaction(async tx=>{
  const [journal,root]=await Promise.all([tx.get(r.journal),tx.get(r.root)]);
  if(journal.exists){journalCheck(journal.data(),m,manifestSha256);return;}
  if(root.exists)throw Error('recovery-target-collision');
  tx.create(r.journal,{format:'tenant-recovery-quarantine-v1',tenantId:m.context.tenantId,manifestSha256,
   enabled:false,activationAllowed:false,state:'staging',nextPage:0,records:0,counts:blankCounts(),lastPath:'',unresolvedDependencies:[...TENANT_RECOVERY_BLOCKERS]});
 });
 const finish=async()=>{
  await verifyTenantRecoveryQuarantine({db,environment,manifest:m,manifestSha256});
  await db.runTransaction(async tx=>{const j=(await tx.get(r.journal)).data();journalCheck(j,m,manifestSha256);if(j.nextPage!==m.pages.length)throw Error('recovery-journal-changed');if(j.state!=='verified_quarantine')tx.update(r.journal,{state:'verified_quarantine'});});
  return {...(await r.journal.get()).data(),state:'verified_quarantine',productionRecoveryAccepted:false};
 };
 const before=(await r.journal.get()).data();journalCheck(before,m,manifestSha256);
 // A crash after the last record batch but before final verification resumes
 // verification, without copying a page twice or stranding a complete image.
 if(before.nextPage===m.pages.length)return finish();
 const index=before.nextPage,rows=await readPage({storage,manifest:m,masterKey,index});
 const next=await db.runTransaction(async tx=>{
  const js=await tx.get(r.journal),j=js.data();
  journalCheck(j,m,manifestSha256);if(j.nextPage!==index||j.state!=='staging')throw Error('recovery-journal-changed');
  let last=j.lastPath;const targets=[];
  for(const row of rows){const path=recordCheck(row,m.context);if(path<=last)throw Error('recovery-record-order');last=path;targets.push(row.collection==='$root'?r.root:r.root.collection(row.collection).doc(row.id));}
  const existing=await Promise.all(targets.map(ref=>tx.get(ref)));if(existing.some(doc=>doc.exists))throw Error('recovery-target-collision');
  const counts={...j.counts};for(const row of rows)counts[row.collection]++;
  for(const [i,row]of rows.entries())tx.create(targets[i],row.collection==='$root'
   ?{enabled:false,activationAllowed:false,sourceTenantId:m.context.tenantId,sourceRoot:row.payload,sourceRecordSha256:hash(bytes(row))}
   :{sourceTenantId:m.context.tenantId,payload:row.payload,sourceRecordSha256:hash(bytes(row))});
  const progress={...j,nextPage:index+1,records:j.records+rows.length,lastPath:last,counts};
  tx.set(r.journal,progress);return progress;
 });
 await afterCommit({page:index,records:rows.length});
 if(next.nextPage<m.pages.length)return {...next,productionRecoveryAccepted:false};
 return finish();
}

export async function verifyTenantRecoveryQuarantine({db,environment=process.env,manifest,manifestSha256}){
 boundary(db,environment);if(!authenticated.has(manifest))throw Error('authenticated-recovery-manifest-required');
 const r=refs(db,manifest.context),j=(await r.journal.get()).data();
 if(!j)throw Error('recovery-journal-conflict');journalCheck(j,manifest,manifestSha256);
 const root=(await r.root.get()).data();if(!root||root.enabled!==false||root.activationAllowed!==false)throw Error('recovery-quarantine-authority');
 const digest=createHash('sha256'),counts=blankCounts();let total=0;
 const accept=row=>{recordCheck(row,manifest.context);digest.update(bytes(row)).update('\n');counts[row.collection]++;total++;if(total>manifest.recordCount)throw Error('recovery-image-reconciliation');};
 const rootRow={collection:'$root',id:manifest.context.tenantId,payload:root.sourceRoot};if(root.sourceRecordSha256!==hash(bytes(rootRow)))throw Error('recovery-target-integrity');accept(rootRow);
 if((await childCollections(environment,r.root.path,TENANT_RECOVERY_COLLECTIONS.length+1)).some(name=>!TENANT_RECOVERY_COLLECTIONS.includes(name)))throw Error('unknown-recovery-collection');
 for(const name of TENANT_RECOVERY_COLLECTIONS)for await(const doc of inventoryDocuments(db,environment,r.root.path,name)){
  const value=doc.data(),row={collection:name,id:doc.id,payload:value.payload};
  if(value.sourceTenantId!==manifest.context.tenantId||value.sourceRecordSha256!==hash(bytes(row)))throw Error('recovery-target-integrity');accept(row);
 }
 if(total!==manifest.recordCount||canonical(counts)!==canonical(manifest.counts)||digest.digest('hex')!==manifest.recordsSha256)throw Error('recovery-image-reconciliation');
 return {verifiedQuarantine:true,recordCount:total,productionRecoveryAccepted:false,activationAllowed:false,unresolvedDependencies:[...TENANT_RECOVERY_BLOCKERS]};
}
