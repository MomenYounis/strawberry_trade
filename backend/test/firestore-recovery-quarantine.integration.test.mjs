import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {canonical} from '../src/validation.mjs';
import {createFirestoreRecoverySource} from '../src/firestore-recovery-source.mjs';
import {exportFirestoreRecoveryImage} from '../src/firestore-recovery-image.mjs';
import {restoreFirestoreRecoveryQuarantine} from '../src/firestore-recovery-quarantine.mjs';
assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:18180');assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:19199');
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert({project_id:DEMO_PROJECT_ID,client_email:'synthetic-provider-recovery@'+DEMO_PROJECT_ID+'.iam.gserviceaccount.com',private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()})},'provider-quarantine-'+randomBytes(5).toString('hex'));
const db=initializeFirestore(app,{preferRest:true});db.settings({host:'127.0.0.1:18180',ssl:false,...emulatorFirestoreSettings(DEMO_PROJECT_ID,process.env)});const auth=getAuth(app);after(()=>deleteApp(app));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function typed(value){if(value===null)return {nullValue:null};if(typeof value==='string')return {stringValue:value};if(typeof value==='number')return {integerValue:String(value)};if(typeof value==='boolean')return {booleanValue:value};if(Array.isArray(value))return {arrayValue:{values:value.map(typed)}};return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typed(v)]))}};}
async function fixture(t,{extra=31,pageBytes=4096,empty=false,auditTextBytes=120}={}){
 const nonce=randomBytes(6).toString('hex'),projectId='demo-provider-recovery',databaseId='(default)',tenantId='provider_'+nonce,imageId='capture_'+nonce,keyId='key_'+nonce,readTime=new Date(Date.now()-1000).toISOString(),nowMs=Date.parse(readTime)+1000;
 const root=`projects/${projectId}/databases/${databaseId}/documents/tenants/${tenantId}`,source={};
 const add=(path,payload)=>{source[root+path]={name:root+path,createTime:new Date(nowMs-60_000).toISOString(),updateTime:new Date(nowMs-2000).toISOString(),fields:Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,typed(v)]))};};
 add('',{enabled:true,ownerUid:'manager_'+nonce,sequence:2,licenseId:'retained_not_activated',entitlementEpoch:7});
 if(!empty){
 add('/entries/a',{tenantId,kind:'sale',totalMinor:7000,paidMinor:0,creatorUid:'manager_'+nonce});add('/entries/b',{tenantId,kind:'sale',totalMinor:3000,paidMinor:0,creatorUid:'employee_'+nonce});
 add('/members/manager_'+nonce,{role:'manager',active:true});add('/members/employee_'+nonce,{role:'employee',active:true});
 add('/devices/bound_old',{active:true,uid:'manager_'+nonce,publicKey:'synthetic_original_key'});
 add('/operations/sale_once',{digest:'a'.repeat(64),actorUid:'manager_'+nonce,result:{id:'sale_once',status:'accepted',sequence:2}});
 add('/returnCounters/a',{qtyMilli:1000,totalMinor:1000});add('/reversalLocks/reverse_once',{operationId:'reversal_once'});add('/reviewLocks/approve_once',{operationId:'approval_once'});add('/salaryLocks/staff_2026-10',{termId:'retained_term'});
 for(let i=0;i<extra;i++)add('/audit/a_'+String(i).padStart(3,'0'),{tenantId,event:'synthetic '+String(i)+' '+'.'.repeat(auditTextBytes)});
 }
 const requests=[],before=hash(source),server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const url=new URL(req.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname.slice(4)),input=body?JSON.parse(body):null;requests.push({method:req.method,path,readTime:input?.readTime??url.searchParams.get('readTime')});
  let output;if(path.endsWith(':listCollectionIds')){const parent=path.slice(0,-18),ids=[...new Set(Object.keys(source).filter(key=>key.startsWith(parent+'/')).map(key=>key.slice(parent.length+1).split('/')).filter(parts=>parts.length>=2).map(parts=>parts[0]))].sort(),offset=Number(input.pageToken??0);output={collectionIds:ids.slice(offset,offset+input.pageSize),...(offset+input.pageSize<ids.length?{nextPageToken:String(offset+input.pageSize)}:{})};}
  else if(source[path])output=source[path];else{const docs=Object.keys(source).filter(key=>key.startsWith(path+'/')&&key.slice(path.length+1).split('/').length===1).sort().map(key=>source[key]),offset=Number(url.searchParams.get('pageToken')??0),size=Number(url.searchParams.get('pageSize'));output={documents:docs.slice(offset,offset+size),...(offset+size<docs.length?{nextPageToken:String(offset+size)}:{})};}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const objects=new Map(),storage={async putImmutable(key,value){const copy=Buffer.from(value);if(objects.has(key)&&!objects.get(key).equals(copy))throw Error('immutable-conflict');objects.set(key,copy);},async read(key,{maxBytes}){const value=objects.get(key);if(!value)throw Error('missing-image-object');if(value.length>maxBytes)throw Error('image-byte-limit');return Buffer.from(value);}};
 const input=createFirestoreRecoverySource({projectId,databaseId,tenantId,readTime,accessToken:async()=>'synthetic-token',endpoint:'http://127.0.0.1:'+server.address().port,allowLoopbackForTests:true,now:()=>nowMs}),masterKey=randomBytes(32),image=await exportFirestoreRecoveryImage({source:input,storage,masterKey,imageId,keyId,createdAtMs:nowMs,pageBytes});
 return {...image,storage,objects,masterKey,expected:{projectId,databaseId,tenantId,readTime,imageId,keyId},source,before,requests,root:db.doc('firestoreRecoveryQuarantine/'+imageId).collection('tenants').doc(tenantId),journal:db.doc('firestoreRecoveryQuarantine/'+imageId)};
}
const restore=(f,extra={})=>restoreFirestoreRecoveryQuarantine({...f,db,...extra});
const authInventory=async()=>hash((await auth.listUsers(1000)).users.map(user=>user.toJSON()).sort((a,b)=>a.uid<b.uid?-1:1));

test('fixed-time provider image recovers exact financial/receipt/lock/member state only into disabled demo quarantine',async t=>{
 const f=await fixture(t);await auth.createUser({uid:'unrelated_'+randomBytes(6).toString('hex'),disabled:true});const authBefore=await authInventory();
 const result=await restore(f);assert.equal(result.state,'verified_quarantine');assert.equal(result.enabled,false);assert.equal(result.activationAllowed,false);assert.equal(result.imageFullyVerified,true);assert.equal(result.targetFullyVerified,true);assert.equal(result.productionRecoveryAccepted,false);
 const root=(await f.root.get()).data();assert.equal(root.enabled,false);assert.equal(root.activationAllowed,false);assert.equal(root.sourceRoot.enabled,true);assert.equal(root.sourceRoot.entitlementEpoch,7);
 const prefix=`projects/${f.expected.projectId}/databases/(default)/documents/tenants/${f.expected.tenantId}`;
 for(const [name,doc]of Object.entries(f.source)){
  const suffix=name.slice(prefix.length);const target=suffix?await db.doc(f.root.path+suffix).get():await f.root.get();assert.ok(target.exists);assert.equal(target.data().sourceMetadata.name,doc.name);
  // The oracle below does not call either production recovery decoder.
  const untype=value=>Object.hasOwn(value,'stringValue')?value.stringValue:Object.hasOwn(value,'integerValue')?Number(value.integerValue):Object.hasOwn(value,'booleanValue')?value.booleanValue:Object.hasOwn(value,'nullValue')?null:Object.hasOwn(value,'arrayValue')?(value.arrayValue.values??[]).map(untype):Object.fromEntries(Object.entries(value.mapValue.fields??{}).map(([key,v])=>[key,untype(v)]));
  assert.deepEqual(suffix?target.data().payload:target.data().sourceRoot,Object.fromEntries(Object.entries(doc.fields).map(([key,value])=>[key,untype(value)])));
 }
 const entries=(await f.root.collection('entries').get()).docs.map(doc=>doc.data().payload);assert.equal(entries.reduce((n,row)=>n+row.totalMinor-row.paidMinor,0),10_000);
 assert.deepEqual((await f.root.collection('operations').doc('sale_once').get()).data().payload.result,{id:'sale_once',status:'accepted',sequence:2});
 assert.equal((await f.root.collection('returnCounters').doc('a').get()).data().payload.qtyMilli,1000);assert.equal((await f.root.collection('reversalLocks').doc('reverse_once').get()).data().payload.operationId,'reversal_once');
 assert.equal(hash(f.source),f.before);assert.equal(await authInventory(),authBefore);assert.ok(f.requests.every(call=>call.readTime===f.expected.readTime&&['GET','POST'].includes(call.method)));
 assert.equal((await db.doc('tenants/'+f.expected.tenantId).get()).exists,false,'No live tenant was created.');
 const before=hash((await f.root.collection('operations').get()).docs.map(doc=>doc.data()));await restore(f);assert.equal(hash((await f.root.collection('operations').get()).docs.map(doc=>doc.data())),before);
});

test('process loss in the middle of an encrypted page resumes the exact prefix without reposting',async t=>{
 const f=await fixture(t),manifest=JSON.parse(f.objects.get(f.manifestKey).toString()),boundaries=[];let total=0;for(const page of manifest.body.pages){total+=page.records;boundaries.push(total);}
 await assert.rejects(restore(f,{afterCommit(){throw Error('simulated-process-loss');}}),/simulated-process-loss/);
 const saved=(await f.journal.get()).data();assert.equal(saved.records,20);assert.equal(saved.state,'staging');assert.equal(boundaries.includes(saved.records),false,'The durable transaction cuts across an image page.');
 const result=await restore(f);assert.equal(result.state,'verified_quarantine');assert.equal(result.records,f.recordCount);assert.equal((await f.root.collection('operations').get()).size,1);
});

test('actual SIGKILL after a committed partial page resumes with identical prior revisions and receipts',async t=>{
 const f=await fixture(t),childSource=`
  import {initializeApp,cert} from 'firebase-admin/app';
  import {initializeFirestore} from 'firebase-admin/firestore';
  import {emulatorFirestoreSettings} from './worker/emulator-firestore-auth.mjs';
  import {restoreFirestoreRecoveryQuarantine} from './src/firestore-recovery-quarantine.mjs';
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1_048_576)throw Error('synthetic-child-input-limit');}
  const input=JSON.parse(raw),app=initializeApp({projectId:input.projectId,credential:cert(input.credential)}),db=initializeFirestore(app,{preferRest:true});
  db.settings({host:'127.0.0.1:18180',ssl:false,...emulatorFirestoreSettings(input.projectId,process.env)});
  const objects=new Map(input.objects.map(([key,value])=>[key,Buffer.from(value,'base64')]));
  await restoreFirestoreRecoveryQuarantine({db,storage:{async read(key,{maxBytes}){const data=objects.get(key);if(!data||data.length>maxBytes)throw Error('synthetic-storage-limit');return data;}},manifestKey:input.manifestKey,manifestSha256:input.manifestSha256,masterKey:Buffer.from(input.masterKey,'hex'),expected:input.expected,afterCommit(){process.kill(process.pid,'SIGKILL');}});
  throw Error('synthetic-child-did-not-crash');
 `;
 const child=spawn(process.execPath,['--input-type=module','--eval',childSource],{cwd:new URL('..',import.meta.url),env:process.env,stdio:['pipe','pipe','pipe']});
 let output='',excessive=false;const limit=chunk=>{output+=chunk.toString();if(output.length>16_384){excessive=true;child.kill('SIGKILL');}};child.stdout.on('data',limit);child.stderr.on('data',limit);
 const timer=setTimeout(()=>child.kill('SIGTERM'),30_000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stdin.end(JSON.stringify({projectId:DEMO_PROJECT_ID,credential:{project_id:DEMO_PROJECT_ID,client_email:'synthetic-process-loss@'+DEMO_PROJECT_ID+'.iam.gserviceaccount.com',private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()},objects:[...f.objects].map(([key,value])=>[key,value.toString('base64')]),manifestKey:f.manifestKey,manifestSha256:f.manifestSha256,masterKey:f.masterKey.toString('hex'),expected:f.expected}));
 const exit=await done;clearTimeout(timer);assert.equal(excessive,false);assert.deepEqual(exit,{code:null,signal:'SIGKILL'},output);
 const saved=(await f.journal.get()).data();assert.equal(saved.records,20);assert.equal(saved.state,'staging');
 const before=await f.root.collection('audit').get(),revisions=new Map(before.docs.map(doc=>[doc.id,doc.updateTime.toMillis()]));assert.ok(revisions.size>0);
 const final=await restore(f);assert.equal(final.state,'verified_quarantine');assert.equal(final.records,f.recordCount);
 for(const [documentId,revision]of revisions)assert.equal((await f.root.collection('audit').doc(documentId).get()).updateTime.toMillis(),revision,'Committed prefix was not rewritten.');
 assert.equal((await f.root.collection('operations').get()).size,1);assert.equal(hash(f.source),f.before);
});

test('root-only image is a complete disabled quarantine and hostile progress journals never advance',async t=>{
 const empty=await fixture(t,{empty:true}),result=await restore(empty);assert.equal(result.records,1);assert.equal(result.state,'verified_quarantine');assert.deepEqual(await empty.root.listCollections(),[]);assert.equal((await empty.root.get()).data().enabled,false);
 for(const change of [{records:-1},{bytes:0},{lastPath:[]},{counts:{$root:1}},{enabled:true},{activationAllowed:true},{verifiedSourceSha256:'f'.repeat(64)},{state:'live'},{unexpected:'field'}]){
  const f=await fixture(t);await restore(f,{maxBatches:1});await f.journal.update(change);const before=(await f.journal.get()).data();
  await assert.rejects(restore(f));assert.deepEqual((await f.journal.get()).data(),before);assert.equal((await f.root.collection('operations').get()).size,0);
 }
});

test('byte-sized batches and competing restorers retain create-only progress without duplicate receipts',async t=>{
 const f=await fixture(t,{extra:3,pageBytes:1_048_576,auditTextBytes:530_000}),cuts=[];
 const first=await restore(f,{afterCommit:({records})=>cuts.push(records)});assert.equal(first.state,'verified_quarantine');
 assert.ok(cuts.length>1);assert.ok(cuts.slice(0,-1).every(records=>records<20),'Byte guard must split before the twenty-row cap.');
 const g=await fixture(t,{extra:45}),racing=await Promise.allSettled([restore(g),restore(g)]);assert.ok(racing.some(item=>item.status==='fulfilled'&&item.value.state==='verified_quarantine'));
 for(const item of racing)if(item.status==='rejected')assert.match(String(item.reason),/journal-changed|target-collision/);
 assert.equal((await g.journal.get()).data().records,g.recordCount);assert.equal((await g.root.collection('operations').get()).size,1);
});

test('explicit batch budget reports staging, resumes once and never pretends a partial image is verified',async t=>{
 const f=await fixture(t),first=await restore(f,{maxBatches:1});assert.equal(first.state,'staging');assert.equal(first.budgetExhausted,true);assert.equal(first.imageFullyVerified,false);assert.equal(first.records,20);
 const final=await restore(f);assert.equal(final.state,'verified_quarantine');assert.equal(final.records,f.recordCount);
 const tiny=await fixture(t);const stopped=await restore(tiny,{maxRuntimeMs:1});assert.equal(stopped.imageFullyVerified,false);assert.equal(stopped.activationAllowed,false);
});

test('wrong key, corrupted pages and an existing target refuse without overwrite or source/Auth mutation',async t=>{
 const f=await fixture(t,{extra:0}),authBefore=await authInventory();await assert.rejects(restore(f,{masterKey:randomBytes(32)}),/authentication/);assert.equal((await f.journal.get()).exists,false);
 const pages=[...f.objects.keys()].filter(key=>key.includes('/pages/')),original=Buffer.from(f.objects.get(pages.at(-1)));f.objects.get(pages.at(-1))[20]^=1;await assert.rejects(restore(f),/page-integrity/);assert.notEqual((await f.journal.get()).data()?.state,'verified_quarantine');f.objects.set(pages.at(-1),original);
 const g=await fixture(t,{extra:0});await g.root.create({unrelated:'preserve'});await assert.rejects(restore(g),/target-collision/);assert.deepEqual((await g.root.get()).data(),{unrelated:'preserve'});assert.equal((await g.journal.get()).exists,false);
 assert.equal(hash(f.source),f.before);assert.equal(await authInventory(),authBefore);
});

test('changed prefix, extra/orphan/nested target documents and verified-target tampering fail reconciliation',async t=>{
 for(const kind of ['prefix','extra','orphan','nested','collection','tenant','journal-children','complete']){
  const f=await fixture(t);await restore(f,{maxBatches:1});
  if(kind==='prefix')await f.journal.update({prefixSha256:'f'.repeat(64)});
  if(kind==='extra')await f.root.collection('audit').doc('z_extra').create({outside:true});
  if(kind==='orphan')await f.root.collection('entries').doc('orphan').collection('hidden').doc('child').create({outside:true});
  if(kind==='nested')await f.root.collection('audit').doc('a_000').collection('hidden').doc('child').create({outside:true});
  if(kind==='collection')await f.root.collection('unsupported').doc('outside').create({outside:true});
  if(kind==='tenant')await f.journal.collection('tenants').doc('outside').create({outside:true});
  if(kind==='journal-children')await f.journal.collection('outside').doc('child').create({outside:true});
  if(kind==='complete'){await restore(f);await f.root.collection('operations').doc('sale_once').update({'payload.digest':'f'.repeat(64)});}
  await assert.rejects(restore(f),/prefix-integrity|target-integrity|orphan-or-path|nested-target|target-collections|extra-tenant|journal-children/);
 }
});

test('remote/different project endpoints reject before any SDK method or image access',async()=>{
 let touched=false;const db={get projectId(){touched=true;throw Error('SDK touched');}},storage={read(){touched=true;throw Error('storage touched');}};
 const environment={GCLOUD_PROJECT:DEMO_PROJECT_ID,FIRESTORE_EMULATOR_HOST:'127.0.0.1:18180',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19199'};
 for(const bad of [{...environment,FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'},{...environment,FIREBASE_AUTH_EMULATOR_HOST:'identitytoolkit.googleapis.com:443'},{...environment,GCLOUD_PROJECT:'live-project'},{...environment,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}])await assert.rejects(restoreFirestoreRecoveryQuarantine({db,storage,environment:bad}),/Local demo|dedicated-emulators/);
 for(const settings of [undefined,{host:'firestore.googleapis.com:443',ssl:true},{host:'127.0.0.1:18180',ssl:true},{servicePath:'firestore.googleapis.com',port:443,ssl:false},{servicePath:'127.0.0.1',port:8080,ssl:false},{servicePath:'127.0.0.1',port:18180,ssl:true}])await assert.rejects(restoreFirestoreRecoveryQuarantine({db:{projectId:DEMO_PROJECT_ID,databaseId:'(default)',_settings:settings,get(){touched=true;}},storage,environment}),/sdk-host/);
 for(const identity of [{projectId:'production-project',databaseId:'(default)'},{projectId:DEMO_PROJECT_ID,databaseId:'other'}])await assert.rejects(restoreFirestoreRecoveryQuarantine({db:{...identity,get(){touched=true;}},storage,environment}),/demo-database-required/);
 assert.equal(touched,false);
});
