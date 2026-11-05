// Distinct encrypted provider capture. Never accepted by the synthetic recovery
// importer and never writes database/Auth state or enables recovered authority.
import {createHash,createHmac,createCipheriv,createDecipheriv,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {FIRESTORE_RECOVERY_LIMITS,isFirestoreRecoverySource,freezeRecoveryValue,recoveryTimestampNanoseconds} from './firestore-recovery-source.mjs';
import {createRecoveryDependencyCollector,createRecoveryDependencyVerifier,buildRecoveryDependencyPlan} from './recovery-dependency-plan.mjs';
import {TENANT_RECOVERY_COLLECTIONS} from './tenant-recovery-quarantine.mjs';
const L=Object.freeze({pageRecords:20,pageBytes:1_048_576,pages:25_001,manifestBytes:8_388_608});
const hex=/^[a-f0-9]{64}$/,collections=['$root',...TENANT_RECOVERY_COLLECTIONS],hash=data=>createHash('sha256').update(data).digest('hex'),bytes=value=>Buffer.from(canonical(value));
function fail(reason){throw Error('firestore-recovery-image-'+reason);}
function schema(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('schema');}
function json(value,depth=0){if(depth>24)fail('depth');if(value===null||typeof value==='boolean')return;if(typeof value==='string')return;if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('number');return;}if(!value||typeof value!=='object'||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)fail('json');for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))fail('property');json(child,depth+1);}}
function parse(data,max){if(!(data instanceof Uint8Array)||data.length>max)fail('byte-limit');let raw,value;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(data);value=JSON.parse(raw);}catch{fail('json');}json(value);if(canonical(value)!==raw)fail('noncanonical');return value;}
function contextCheck(context){schema(context,['projectId','databaseId','tenantId','readTime','imageId','keyId','createdAtMs']);for(const key of ['tenantId','imageId','keyId'])id(context[key]);if(typeof context.projectId!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(context.projectId)||typeof context.databaseId!=='string'||!(/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(context.databaseId)||context.databaseId==='(default)')||typeof context.readTime!=='string'||!Number.isFinite(Date.parse(context.readTime)))fail('context');integer(context.createdAtMs,0,Number.MAX_SAFE_INTEGER);}
function derive(master,context,purpose){if(!(master instanceof Uint8Array)||master.length!==32)fail('key-required');return Buffer.from(hkdfSync('sha256',master,bytes(context),Buffer.from('strawberry-firestore-recovery-v1/'+purpose),32));}
function mac(body,master){const key=derive(master,body.context,'manifest');try{return createHmac('sha256',key).update(bytes(body)).digest('hex');}finally{key.fill(0);}}
function crypt(data,master,context,index,decrypt=false){const key=derive(master,context,'page/'+index),nonce=decrypt?data.subarray(0,12):randomBytes(12);try{const cipher=decrypt?createDecipheriv('aes-256-gcm',key,nonce):createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(bytes({format:'firestore-recovery-v1',context,index}));if(decrypt){cipher.setAuthTag(data.subarray(-16));return Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]);}return Buffer.concat([nonce,cipher.update(data),cipher.final(),cipher.getAuthTag()]);}catch{fail('authentication');}finally{key.fill(0);}}
function namespace(c){return `firestore-recovery/v1/${c.projectId}/${c.tenantId}/${c.imageId}`;}
function rowCheck(row,context){schema(row,['collection','id','payload','source']);if(!collections.includes(row.collection))fail('collection');id(row.id);if(row.collection==='$root'&&row.id!==context.tenantId)fail('tenant');schema(row.source,['name','createTime','updateTime']);const suffix=row.collection==='$root'?'':`/${row.collection}/${row.id}`;if(row.source.name!==`projects/${context.projectId}/databases/${context.databaseId}/documents/tenants/${context.tenantId}${suffix}`)fail('document-path');if(!row.payload||Object.getPrototypeOf(row.payload)!==Object.prototype||Object.hasOwn(row.payload,'tenantId')&&row.payload.tenantId!==context.tenantId)fail('tenant');json(row);if(bytes(row).length>FIRESTORE_RECOVERY_LIMITS.recordBytes)fail('record-limit');return row.collection+'/'+row.id;}

export async function exportFirestoreRecoveryImage({source,storage,masterKey,imageId,keyId,createdAtMs,pageBytes=L.pageBytes,dependencyEvidence={}}){
 if(!isFirestoreRecoverySource(source)||typeof storage?.putImmutable!=='function')fail('branded-source-and-storage-required');
 const context={...source.context,imageId,keyId,createdAtMs};contextCheck(context);integer(pageBytes,1024,L.pageBytes);derive(masterKey,context,'check').fill(0);
 const pages=[],collector=createRecoveryDependencyCollector();let rows=[],size=2;
 async function flush(){if(!rows.length)return;if(pages.length>=L.pages)fail('page-limit');const plain=bytes(rows),index=pages.length,cipher=crypt(plain,masterKey,context,index),cipherSha256=hash(cipher),key=namespace(context)+'/pages/'+cipherSha256;
  try{await storage.putImmutable(key,cipher);pages.push({index,key,records:rows.length,plainBytes:plain.length,cipherBytes:cipher.length,plainSha256:hash(plain),cipherSha256});}finally{plain.fill(0);cipher.fill(0);}rows=[];size=2;}
 const sourceProof=await source.capture({async writeRecord(row){const raw=bytes(row);rowCheck(row,context);if(raw.length+2>pageBytes)fail('record-page-limit');if(rows.length&&(rows.length===L.pageRecords||size+raw.length+1>pageBytes))await flush();collector.observe(row);rows.push(row);size+=raw.length+1;}});
 await flush();const required=collector.finish({sourceProof,imageKeyId:keyId}),dependencyPlan=buildRecoveryDependencyPlan({required,evidence:dependencyEvidence});
 const body={format:'strawberry-firestore-recovery',version:1,algorithm:'AES-256-GCM/HKDF-SHA256/HMAC-SHA256',context,sourceProof,pages,dependencyPlan,activationAllowed:false};
 const manifest=bytes({body,mac:mac(body,masterKey)});if(manifest.length>L.manifestBytes)fail('manifest-limit');const manifestSha256=hash(manifest),manifestKey=namespace(context)+'/manifests/'+manifestSha256;
 await storage.putImmutable(manifestKey,manifest);
 return freezeRecoveryValue({manifestKey,manifestSha256,recordCount:sourceProof.records,pageCount:pages.length,sourceProof,dependencyPlan,activationAllowed:false,productionDurabilityAccepted:false});
}

// Sequential, bounded authentication/verification only. The optional observer
// must treat rows as uncommitted until this entire method returns successfully.
export async function verifyFirestoreRecoveryImage({storage,manifestKey,manifestSha256,masterKey,expected,onRecord=async()=>{}}){
 if(typeof storage?.read!=='function'||typeof onRecord!=='function'||!hex.test(manifestSha256)||!expected)fail('verification-arguments');
 const raw=await storage.read(manifestKey,{maxBytes:L.manifestBytes});if(hash(raw)!==manifestSha256)fail('manifest-integrity');
 const envelope=parse(raw,L.manifestBytes);schema(envelope,['body','mac']);const b=envelope.body;
 schema(b,['format','version','algorithm','context','sourceProof','pages','dependencyPlan','activationAllowed']);contextCheck(b.context);
 if(b.format!=='strawberry-firestore-recovery'||b.version!==1||b.algorithm!=='AES-256-GCM/HKDF-SHA256/HMAC-SHA256'||b.activationAllowed!==false||manifestKey!==namespace(b.context)+'/manifests/'+manifestSha256)fail('format');
 for(const key of ['projectId','databaseId','tenantId','readTime','imageId','keyId'])if(expected[key]!==b.context[key])fail('expected-context');
 if(!hex.test(envelope.mac)||!timingSafeEqual(Buffer.from(envelope.mac,'hex'),Buffer.from(mac(b,masterKey),'hex')))fail('authentication');
 const p=b.sourceProof;schema(p,['kind','projectId','databaseId','tenantId','readTime','readTimeCapability','productionSourceConsistencyAccepted','localTransportFixture','collections','counts','records','bytes','wireBytes','requests','documentsSha256','inventorySha256','rootUpdateTime']);
 if(p.kind!=='firestore-rest-fixed-read-time-v1'||p.productionSourceConsistencyAccepted!==false||typeof p.localTransportFixture!=='boolean'||!['one-hour','explicit-pitr'].includes(p.readTimeCapability)||canonical(p.collections)!==canonical(collections)||p.inventorySha256!==hash(bytes(collections))||!hex.test(p.documentsSha256))fail('source-proof');
 for(const key of ['projectId','databaseId','tenantId','readTime'])if(p[key]!==b.context[key])fail('source-context');
 integer(p.records,1,FIRESTORE_RECOVERY_LIMITS.records);integer(p.bytes,1,FIRESTORE_RECOVERY_LIMITS.totalBytes);integer(p.wireBytes,1,FIRESTORE_RECOVERY_LIMITS.wireBytes);integer(p.requests,1,FIRESTORE_RECOVERY_LIMITS.requests);
 schema(p.counts,collections);for(const n of Object.values(p.counts))integer(n,0,FIRESTORE_RECOVERY_LIMITS.records);if(p.counts.$root!==1||Object.values(p.counts).reduce((a,n)=>a+n,0)!==p.records)fail('counts');
 if(!Array.isArray(b.pages)||!b.pages.length||b.pages.length>L.pages)fail('page-limit');
 const plan=b.dependencyPlan;if(plan?.activationAllowed!==false||plan?.source?.documentsSha256!==p.documentsSha256||plan?.evidenceStatus!=='supplied-inventory-not-provider-acceptance'||!plan.activationBlockers?.includes('production-activation-not-implemented'))fail('dependency-plan');
 const dependencyVerifier=createRecoveryDependencyVerifier(plan),readNs=recoveryTimestampNanoseconds(b.context.readTime,{microseconds:true});
 if(recoveryTimestampNanoseconds(p.rootUpdateTime)>readNs)fail('source-time');
 let records=0,total=0,last='';const counts=Object.fromEntries(collections.map(c=>[c,0])),digest=createHash('sha256');
 for(const [index,page]of b.pages.entries()){
  schema(page,['index','key','records','plainBytes','cipherBytes','plainSha256','cipherSha256']);
  if(page.index!==index||!hex.test(page.plainSha256)||!hex.test(page.cipherSha256)||page.key!==namespace(b.context)+'/pages/'+page.cipherSha256)fail('page-descriptor');
  integer(page.records,1,L.pageRecords);integer(page.plainBytes,2,L.pageBytes);if(page.cipherBytes!==page.plainBytes+28)fail('page-bytes');
  const cipher=await storage.read(page.key,{maxBytes:page.cipherBytes});if(cipher.length!==page.cipherBytes||hash(cipher)!==page.cipherSha256)fail('page-integrity');const plain=crypt(cipher,masterKey,b.context,index,true);
  try{
   if(plain.length!==page.plainBytes||hash(plain)!==page.plainSha256)fail('plaintext-integrity');const rows=parse(plain,L.pageBytes);if(!Array.isArray(rows)||rows.length!==page.records)fail('page-records');
   for(const row of rows){const key=rowCheck(row,b.context);if(key<=last)fail('record-order');last=key;
    const created=recoveryTimestampNanoseconds(row.source.createTime),updated=recoveryTimestampNanoseconds(row.source.updateTime);if(created>updated||updated>readNs)fail('document-time');
    const raw=bytes(row);if(++records>p.records||(total+=raw.length)>p.bytes)fail('source-limit');counts[row.collection]++;digest.update(raw).update('\n');dependencyVerifier.observe(row);await onRecord(freezeRecoveryValue(row));}
  }finally{plain.fill(0);}
 }
 if(records!==p.records||total!==p.bytes||canonical(counts)!==canonical(p.counts)||digest.digest('hex')!==p.documentsSha256)fail('source-integrity');
 dependencyVerifier.finish({sourceProof:p,imageKeyId:b.context.keyId});
 return freezeRecoveryValue({manifestSha256,sourceProof:p,recordCount:records,dependencyPlan:plan,activationAllowed:false,productionDurabilityAccepted:false});
}
