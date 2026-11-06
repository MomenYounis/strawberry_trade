// Demo-only recovery exercise. Provider images can be examined in a separate
// disabled namespace; this module has no production override or Auth API.
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from './demo-operator.mjs';
import {decodeRecoveryFields,FIRESTORE_RECOVERY_LIMITS} from './firestore-recovery-source.mjs';
import {verifyFirestoreRecoveryImage} from './firestore-recovery-image.mjs';
import {TENANT_RECOVERY_COLLECTIONS} from './tenant-recovery-quarantine.mjs';
const collections=['$root',...TENANT_RECOVERY_COLLECTIONS],hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const emptyHash=createHash('sha256').digest('hex'),hex=/^[a-f0-9]{64}$/;
const blankCounts=()=>Object.fromEntries(collections.map(name=>[name,0]));
const fail=reason=>{throw Error('firestore-recovery-quarantine-'+reason);};
const budgetStop=Symbol('explicit-quarantine-budget');
function boundary(db,environment){
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,environment);
 if(environment.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18180'||environment.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:19199')fail('dedicated-emulators-required');
 if(db?.projectId!==DEMO_PROJECT_ID||db.databaseId!=='(default)')fail('demo-database-required');
 // The environment is checked before touching SDK methods. An explicitly
 // configured non-emulator SDK host must not bypass that environment guard.
 const settings=db._settings,local=settings?.host==='127.0.0.1:18180'||settings?.servicePath==='127.0.0.1'&&settings?.port===18180;
 if(!local||settings.ssl!==false)fail('sdk-host');
}
function schema(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('schema');}
function targetValue(row,context){
 const common={sourceProjectId:context.projectId,sourceDatabaseId:context.databaseId,sourceTenantId:context.tenantId,sourceMetadata:row.source,sourceRecordSha256:hash(row)};
 return row.collection==='$root'?{format:'firestore-recovery-quarantine-root-v1',enabled:false,activationAllowed:false,...common,sourceRoot:row.payload}
  :{format:'firestore-recovery-quarantine-record-v1',...common,payload:row.payload};
}
function journalCheck(j,context,manifestSha256){
 schema(j,['format','context','manifestSha256','enabled','activationAllowed','state','records','bytes','prefixSha256','lastPath','counts','verifiedSourceSha256']);
 if(j.format!=='firestore-recovery-quarantine-v1'||canonical(j.context)!==canonical(context)||j.manifestSha256!==manifestSha256||j.enabled!==false||j.activationAllowed!==false||!['staging','verified_quarantine'].includes(j.state))fail('journal-conflict');
 integer(j.records,0,FIRESTORE_RECOVERY_LIMITS.records);integer(j.bytes,0,FIRESTORE_RECOVERY_LIMITS.totalBytes);schema(j.counts,collections);for(const n of Object.values(j.counts))integer(n,0,FIRESTORE_RECOVERY_LIMITS.records);
 if(Object.values(j.counts).reduce((n,c)=>n+c,0)!==j.records||j.counts.$root!==(j.records?1:0)||typeof j.lastPath!=='string'||j.lastPath.length>250||!hex.test(j.prefixSha256)||(!j.records&&(j.bytes!==0||j.lastPath!==''||j.prefixSha256!==emptyHash))||j.state==='verified_quarantine'&&j.verifiedSourceSha256!==j.prefixSha256||j.state==='staging'&&j.verifiedSourceSha256!=='')fail('journal-progress');
}

export async function restoreFirestoreRecoveryQuarantine({db,environment=process.env,storage,manifestKey,manifestSha256,masterKey,expected,
 maxBatches=25_001,maxRuntimeMs=1_800_000,afterCommit=async()=>{}}){
 boundary(db,environment);integer(maxBatches,1,25_001);integer(maxRuntimeMs,1,1_800_000);if(typeof afterCommit!=='function'||!hex.test(manifestSha256)||!expected)fail('arguments');
 const context=Object.fromEntries(['projectId','databaseId','tenantId','readTime','imageId','keyId'].map(key=>[key,expected[key]]));
 for(const key of ['tenantId','imageId','keyId'])id(context[key]);
 const journal=db.doc('firestoreRecoveryQuarantine/'+context.imageId),root=journal.collection('tenants').doc(context.tenantId),started=performance.now();
 let batches=0,stopped=false,progress=(await journal.get()).data()??null;
 if(progress)journalCheck(progress,context,manifestSha256);
 const starting=progress?structuredClone(progress):null,prefixRecords=progress?.records??0;
 const initial={format:'firestore-recovery-quarantine-v1',context,manifestSha256,enabled:false,activationAllowed:false,state:'staging',records:0,bytes:0,prefixSha256:emptyHash,lastPath:'',counts:blankCounts(),verifiedSourceSha256:''};
 const remaining=()=>Math.floor(maxRuntimeMs-(performance.now()-started));
 function check(){boundary(db,environment);if(remaining()<=0)throw budgetStop;}
 async function timed(operation){check();let timer;try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(budgetStop),remaining());})]);}finally{clearTimeout(timer);}}
 const safeStorage={read:(key,options)=>timed(()=>storage.read(key,options))};
 const digest=createHash('sha256'),counts=blankCounts();let records=0,recordBytes=0,lastPath='',pending=[],pendingBytes=0;
 const ref=row=>row.collection==='$root'?root:root.collection(row.collection).doc(row.id);
 function progressNow(){return {...initial,records,bytes:recordBytes,prefixSha256:digest.copy().digest('hex'),lastPath,counts:{...counts}};}
 async function flush(){
  if(!pending.length)return;check();const rows=pending,values=rows.map(row=>targetValue(row,context)),targets=rows.map(ref),end=progressNow();
  if(records<=prefixRecords){
   const found=await timed(()=>db.getAll(...targets));for(const [i,snapshot]of found.entries())if(!snapshot.exists||canonical(snapshot.data())!==canonical(values[i]))fail('target-integrity');
   if(records===prefixRecords&&(!starting||end.prefixSha256!==starting.prefixSha256||end.bytes!==starting.bytes||end.lastPath!==starting.lastPath||canonical(end.counts)!==canonical(starting.counts)))fail('prefix-integrity');
  }else{
   if(progress?.state==='verified_quarantine')fail('verified-prefix-short');
   await db.runTransaction(async tx=>{
    check();const found=(await tx.get(journal)).data()??null;
    if(canonical(found)!==canonical(progress))fail('journal-changed');
    const existing=await Promise.all(targets.map(target=>tx.get(target)));if(existing.some(doc=>doc.exists))fail('target-collision');
    for(const [index,target]of targets.entries())tx.create(target,values[index]);
    check();if(found)tx.update(journal,end);else tx.create(journal,end);
   });
   progress=end;batches++;await afterCommit({batch:batches,records:progress.records});check();
   if(batches>=maxBatches)throw budgetStop;
  }
  pending=[];pendingBytes=0;
 }
 let verified;
 try{
  verified=await verifyFirestoreRecoveryImage({storage:safeStorage,manifestKey,manifestSha256,masterKey,expected:context,async onRecord(row){
   check();const value=targetValue(row,context),size=Buffer.byteLength(canonical(value));if(size>1_048_576)fail('record-byte-limit');
   if(pending.length&&(pending.length===20||pendingBytes+size>1_048_576))await flush();
   records++;recordBytes+=Buffer.byteLength(canonical(row));counts[row.collection]++;lastPath=row.collection+'/'+row.id;digest.update(canonical(row)).update('\n');pending.push(row);pendingBytes+=size;
   // A resumed prefix is compared before creating any following document.
   if(records===prefixRecords)await flush();
  }});
  await flush();
  if(records<prefixRecords||!progress||progress.records!==verified.recordCount||progress.prefixSha256!==verified.sourceProof.documentsSha256)fail('image-progress');
  await verifyTarget({db,environment,root,journal,context,progress,proof:verified.sourceProof,check,timed});
  const final=await db.runTransaction(async tx=>{
   check();const latest=(await tx.get(journal)).data();journalCheck(latest,context,manifestSha256);
   if(canonical(latest)!==canonical(progress))fail('journal-changed');
   const done={...latest,state:'verified_quarantine',verifiedSourceSha256:verified.sourceProof.documentsSha256};
   check();tx.update(journal,done);return done;
  });
  return {...final,imageFullyVerified:true,targetFullyVerified:true,productionRecoveryAccepted:false};
 }catch(error){
  if(error!==budgetStop)throw error;stopped=true;
 }
 // Deliberately no automatic one-batch loop: each explicit resume re-reads the
 // image and exact committed prefix once. Prefer a full invocation budget.
 return {...(progress??initial),budgetExhausted:stopped,newBatches:batches,imageFullyVerified:false,targetFullyVerified:false,productionRecoveryAccepted:false};
}

async function verifyTarget({db,environment,root,journal,context,progress,proof,check,timed}){
 let wireBytes=0,requests=0;
 async function request(path,{body,query={}}={}){
  check();if(++requests>FIRESTORE_RECOVERY_LIMITS.requests)fail('inventory-request-limit');
  const url=new URL(`http://${environment.FIRESTORE_EMULATOR_HOST}/v1/projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${path}`);
  if(!body)url.search=new URLSearchParams(query).toString();
  const result=await timed(async()=>{
   const response=await fetch(url,{method:body?'POST':'GET',headers:{authorization:'Bearer owner',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30_000)});
   if(!response.ok){await response.body?.cancel().catch(()=>{});fail('inventory-http');}const reader=response.body.getReader(),chunks=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;wireBytes+=value.length;if(size>1_048_576||wireBytes>FIRESTORE_RECOVERY_LIMITS.wireBytes)fail('inventory-byte-limit');chunks.push(Buffer.from(value));check();}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('inventory-json');}
  });return result;
 }
 async function childCollections(path){const result=await request(path+':listCollectionIds',{body:{pageSize:TENANT_RECOVERY_COLLECTIONS.length+1}});if(!Array.isArray(result.collectionIds??[])||result.nextPageToken)fail('inventory-collection-limit');return (result.collectionIds??[]).sort();}
 const top=await childCollections(journal.path);if(canonical(top)!==canonical(['tenants']))fail('journal-children');
 const tenants=await request(journal.path+'/tenants',{query:{pageSize:'2',showMissing:'true','mask.fieldPaths':'sourceTenantId'}});
 if(tenants.nextPageToken||tenants.documents?.length!==1||tenants.documents[0].name!==`projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${root.path}`)fail('extra-tenant');
 const foundCollections=await childCollections(root.path),expectedCollections=TENANT_RECOVERY_COLLECTIONS.filter(name=>proof.counts[name]>0);
 if(canonical(foundCollections)!==canonical(expectedCollections))fail('target-collections');
 const digest=createHash('sha256'),counts=blankCounts();let records=0,bytes=0;
 function accept(collection,documentId,value){
  const row={collection,id:documentId,payload:collection==='$root'?value.sourceRoot:value.payload,source:value.sourceMetadata};
  if(canonical(value)!==canonical(targetValue(row,context)))fail('target-integrity');
  const raw=canonical(row);records++;bytes+=Buffer.byteLength(raw);counts[collection]++;if(records>proof.records||bytes>proof.bytes)fail('target-limit');digest.update(raw).update('\n');
 }
 accept('$root',context.tenantId,(await timed(()=>root.get())).data());
 for(const collection of expectedCollections){
  let pageToken='',last='',pages=0;
  do{
   check();if(++pages>proof.records+1)fail('inventory-page-limit');
   const page=await request(root.path+'/'+collection,{query:{pageSize:'1',showMissing:'true',...(pageToken?{pageToken}:{})}});
   if(!Array.isArray(page.documents??[])||(page.documents??[]).length>1)fail('inventory-page');
   for(const doc of page.documents??[]){
    const prefix=`projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${root.path}/${collection}/`;
    if(typeof doc.name!=='string'||!doc.name.startsWith(prefix)||!doc.updateTime||!doc.createTime)fail('orphan-or-path');
    const documentId=doc.name.slice(prefix.length);id(documentId);if(documentId<=last)fail('inventory-order');last=documentId;
    if((await childCollections(root.path+'/'+collection+'/'+documentId)).length)fail('nested-target');
    accept(collection,documentId,decodeRecoveryFields(doc.fields??{}));
   }
   const next=page.nextPageToken??'';if(typeof next!=='string'||next.length>4096||next&&next===pageToken||next&&!(page.documents??[]).length)fail('inventory-token');pageToken=next;
  }while(pageToken);
 }
 if(records!==proof.records||bytes!==proof.bytes||canonical(counts)!==canonical(proof.counts)||digest.digest('hex')!==proof.documentsSha256)fail('target-reconciliation');
 const latest=(await timed(()=>journal.get())).data();if(canonical(latest)!==canonical(progress))fail('journal-changed');
}
