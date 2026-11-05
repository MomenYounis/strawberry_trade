import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash,generateKeyPairSync} from 'node:crypto';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {canonical} from '../src/validation.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {TENANT_RECOVERY_COLLECTIONS,TENANT_RECOVERY_BLOCKERS,SyntheticTenantRecoveryStorage,
 createSyntheticTenantRecoverySource,exportSyntheticTenantRecoveryImage,readTenantRecoveryManifest,
 restoreTenantRecoveryStep,verifyTenantRecoveryQuarantine} from '../src/tenant-recovery-quarantine.mjs';

assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:18180');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:19199');
// Explicit unusable synthetic credentials avoid any ADC/GCE metadata discovery.
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert({project_id:DEMO_PROJECT_ID,
 client_email:'synthetic-recovery@'+DEMO_PROJECT_ID+'.iam.gserviceaccount.com',
 private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()})},'tenant-recovery-'+randomBytes(5).toString('hex'));
const db=initializeFirestore(app,{preferRest:true}),auth=getAuth(app);
db.settings(emulatorFirestoreSettings(DEMO_PROJECT_ID,process.env));
after(()=>deleteApp(app));
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
async function fixture({extra=25,pageBytes=4096}={}){
 const nonce=randomBytes(8).toString('hex'),tenantId='recovery_'+nonce,imageId='image_'+nonce;
 const root=db.doc('tenants/'+tenantId),masterKey=randomBytes(32),storage=new SyntheticTenantRecoveryStorage();
 await root.create({ownerUid:'manager_'+nonce,enabled:true,sequence:77,entitlementEpoch:3,licenseId:'retained_license',
  archivePolicy:{closedThroughDate:'2027-09-01',checkpointSequence:70,closeVersion:1},historyFloor:50,minimumSyncProtocol:2});
 // Every known collection is represented, including authority, archive metadata,
 // receipts/locks/counters. Unknown future collections must not be omitted.
 for(const name of TENANT_RECOVERY_COLLECTIONS)await root.collection(name).doc('retained').create({id:'retained',tenantId,
  marker:'private synthetic '+name,revision:1});
 await root.collection('parties').doc('customer').create({id:'customer',tenantId,kind:'merchant',openingMinor:0,name:'عميل استعادة تجريبي'});
 await root.collection('parties').doc('supplier').create({id:'supplier',tenantId,kind:'supplier',openingMinor:0,name:'مورد استعادة تجريبي'});
 for(const [id,kind,partyId,totalMinor,paidMinor]of [
  ['sale','sale','customer',2000000,0],['purchase','purchase','supplier',2000000,0],
  ['collection','merchant_payment','customer',500000,500000],['payment','supplier_payment','supplier',500000,500000],
 ])await root.collection('entries').doc(id).create({id,tenantId,kind,partyId,totalMinor,paidMinor,date:'2027-09-02'});
 await root.collection('operations').doc('sale_operation').create({actorUid:'manager_'+nonce,digest:'a'.repeat(64),result:{id:'sale_operation',status:'accepted',sequence:71}});
 await root.collection('returnCounters').doc('sale').create({qtyMilli:2500,totalMinor:500000});
 await root.collection('reversalLocks').doc('old_return').create({operationId:'reverse_return'});
 await root.collection('reviewLocks').doc('submission').create({operationId:'approve_once'});
 await root.collection('salaryLocks').doc('staff_2027-08').create({id:'old_term'});
 await root.collection('lateCorrectionLocks').doc('late_sale').create({operationId:'correction_once',entryId:'current_correction'});
 await root.collection('archiveRuns').doc('2026').create({state:'verified',checkpoint:{sequence:70,version:1},manifest:{key:'retained_private_object',sha256:'b'.repeat(64)}});
 for(let i=0;i<extra;i++)await root.collection('audit').doc('extra_'+String(i).padStart(4,'0')).create({tenantId,event:'retained_'+i,atMs:i});
 const context={tenantId,imageId,sourceProjectId:DEMO_PROJECT_ID,keyId:'synthetic_only',createdAtMs:Date.now()};
 const source=await createSyntheticTenantRecoverySource({db,tenantId,pageSize:7});
 const image=await exportSyntheticTenantRecoveryImage({source,storage,masterKey,context,pageBytes});
 return {tenantId,imageId,root,masterKey,storage,context,source,...image};
}
const manifest=f=>readTenantRecoveryManifest({...f,expected:f.context});
const step=(f,extra={})=>restoreTenantRecoveryStep({...f,db,expected:f.context,...extra});
async function finish(f){let result;for(let i=0;i<100;i++){result=await step(f);if(result.state==='verified_quarantine')return result;}throw Error('test-page-budget');}
const quarantine=f=>db.doc('tenantRecoveryQuarantine/'+f.imageId).collection('tenants').doc(f.tenantId);

test('encrypted dependency-complete image restores exact scoped state into disabled separate quarantine only',async()=>{
 const f=await fixture(),m=await manifest(f);
 assert.equal(f.productionSourceConsistencyAccepted,false);assert.equal(f.productionDurabilityAccepted,false);
 assert.deepEqual(m.collections,['$root',...TENANT_RECOVERY_COLLECTIONS]);
 assert.equal(m.sourceProof.productionSourceConsistencyAccepted,false);
 for(const data of f.storage.objects.values())assert.equal(data.includes(Buffer.from('private synthetic')),false);
 const authBefore=(await auth.listUsers(100)).users.map(user=>user.uid);
 const result=await finish(f),target=quarantine(f),root=(await target.get()).data();
 assert.equal(result.productionRecoveryAccepted,false);assert.equal(result.enabled,false);assert.equal(result.activationAllowed,false);
 assert.deepEqual(result.unresolvedDependencies,[...TENANT_RECOVERY_BLOCKERS]);
 assert.equal(root.enabled,false);assert.equal(root.activationAllowed,false);
 assert.deepEqual(root.sourceRoot,(await f.root.get()).data());
 assert.equal((await f.root.get()).data().enabled,true,'Source/live tenant is not disabled or changed by recovery.');
 for(const name of TENANT_RECOVERY_COLLECTIONS){
  const original=await f.root.collection(name).get(),restored=await target.collection(name).get();
  assert.equal(restored.size,original.size,name+' count');
  for(const doc of original.docs){const copied=restored.docs.find(row=>row.id===doc.id).data();assert.deepEqual(copied.payload,doc.data(),name+'/'+doc.id+' exact logical bytes');}
 }
 // Independent elementary accounting; no app/archive financial formula imported.
 const entries=(await target.collection('entries').get()).docs.map(doc=>doc.data().payload);
 const balance=party=>entries.filter(e=>e.partyId===party).reduce((n,e)=>n+
  (['sale','purchase'].includes(e.kind)?e.totalMinor-e.paidMinor:-e.paidMinor),0);
 assert.equal(balance('customer'),1500000);assert.equal(balance('supplier'),1500000);
 assert.deepEqual((await auth.listUsers(100)).users.map(user=>user.uid),authBefore,'No Auth user is recreated or issued authority.');
 const beforeHash=hash((await target.collection('operations').get()).docs.map(d=>[d.id,d.data()]));
 await step(f);await step(f);
 assert.equal(hash((await target.collection('operations').get()).docs.map(d=>[d.id,d.data()])),beforeHash,'Repeated recovery is not another posting/receipt.');
});

test('crash after committed page and after final page resumes journal without duplicate creates',async()=>{
 const f=await fixture({extra:2,pageBytes:2048}),m=await manifest(f);
 assert.ok(m.pages.length>1);
 await assert.rejects(()=>step(f,{afterCommit:async()=>{throw Error('simulated-process-loss');}}),/simulated-process-loss/);
 const journal=db.doc('tenantRecoveryQuarantine/'+f.imageId);
 assert.equal((await journal.get()).data().nextPage,1);
 while((await journal.get()).data().nextPage<m.pages.length-1)await step(f);
 await assert.rejects(()=>step(f,{afterCommit:async()=>{throw Error('last-page-process-loss');}}),/last-page-process-loss/);
 assert.equal((await journal.get()).data().nextPage,m.pages.length);assert.equal((await journal.get()).data().state,'staging');
 assert.equal((await step(f)).state,'verified_quarantine');
 assert.equal((await verifyTenantRecoveryQuarantine({db,manifest:m,manifestSha256:f.manifestSha256})).verifiedQuarantine,true);
});

test('wrong key/context, changed ciphertext and missing pages refuse and preserve source',async()=>{
 const f=await fixture({extra:0}),original=hash((await f.root.get()).data());
 await assert.rejects(()=>step(f,{masterKey:randomBytes(32)}),/authentication/);
 assert.equal((await db.doc('tenantRecoveryQuarantine/'+f.imageId).get()).exists,false);
 await assert.rejects(()=>step(f,{expected:{...f.context,tenantId:'different'}}),/context/);
 const m=await manifest(f),page=m.pages[0],originalPage=f.storage.objects.get(page.key);
 f.storage.objects.set(page.key,Buffer.from(originalPage));f.storage.objects.get(page.key)[13]^=1;
 await assert.rejects(()=>step(f),/integrity/);
 assert.equal((await db.doc('tenantRecoveryQuarantine/'+f.imageId).get()).data().records,0);
 f.storage.objects.set(page.key,originalPage);f.storage.objects.delete(page.key);
 await assert.rejects(()=>step(f),/missing/);
 assert.equal(hash((await f.root.get()).data()),original);
});

test('preexisting target documents and altered journals/complete targets are never overwritten',async()=>{
 const f=await fixture({extra:0}),target=quarantine(f);
 await target.create({unrelated:'preserve me'});
 await assert.rejects(()=>step(f),/collision/);assert.deepEqual((await target.get()).data(),{unrelated:'preserve me'});
 const g=await fixture({extra:0});await finish(g);const journal=db.doc('tenantRecoveryQuarantine/'+g.imageId);
 await journal.update({nextPage:0});await assert.rejects(()=>step(g),/journal-progress/);
 const h=await fixture({extra:0});await finish(h);const receipt=quarantine(h).collection('operations').doc('sale_operation');
 await receipt.update({'payload.digest':'c'.repeat(64)});
 await assert.rejects(()=>step(h),/integrity/);assert.equal((await receipt.get()).data().payload.digest,'c'.repeat(64));
});

test('unknown collections, nested metadata and unsupported Firestore types fail instead of being omitted',async()=>{
 for(const kind of ['unknown','nested','type']){
  const tenantId='invalid_'+randomBytes(6).toString('hex'),root=db.doc('tenants/'+tenantId);await root.create({enabled:true});
  if(kind==='unknown')await root.collection('unreviewedNewCollection').doc('x').create({value:1});
  else if(kind==='nested')await root.collection('archiveRuns').doc('2026').collection('unreviewedChildren').doc('x').create({value:1});
  else await root.collection('audit').doc('fraction').create({value:0.5});
  await assert.rejects(()=>createSyntheticTenantRecoverySource({db,tenantId}),kind==='unknown'?/unknown/:kind==='nested'?/nested/:/unsafe-number/);
 }
});

test('source changes during export leave only unreferenced encrypted pages and no accepted manifest',async()=>{
 const f=await fixture({extra:0}),storage=new SyntheticTenantRecoveryStorage(),basePut=storage.putImmutable.bind(storage);let changed=false;
 storage.putImmutable=async(key,data)=>{await basePut(key,data);if(!changed){changed=true;await f.root.collection('members').doc('retained').update({revision:2});}};
 await assert.rejects(()=>exportSyntheticTenantRecoveryImage({...f,source:f.source,storage,context:{...f.context,imageId:'changed_'+f.imageId},pageBytes:2048}),/source-changed/);
 assert.ok(storage.objects.size>0);assert.ok([...storage.objects.keys()].every(key=>key.includes('/pages/')));
});

test('production, remote endpoints, unbranded sources and cloned manifests are refused before activation',async()=>{
 const environment={GCLOUD_PROJECT:DEMO_PROJECT_ID,FIRESTORE_EMULATOR_HOST:'127.0.0.1:18180',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19199'};
 await assert.rejects(()=>createSyntheticTenantRecoverySource({db:{projectId:'live-project'},tenantId:'x',environment}),/synthetic/);
 await assert.rejects(()=>createSyntheticTenantRecoverySource({db,tenantId:'x',environment:{...environment,FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'}}),/Local demo/);
 const f=await fixture({extra:0}),m=await manifest(f);
 await assert.rejects(()=>exportSyntheticTenantRecoveryImage({...f,source:{...f.source}}),/adapter-required/);
 await assert.rejects(()=>verifyTenantRecoveryQuarantine({db,manifest:{...m},manifestSha256:f.manifestSha256}),/authenticated/);
});

test('racing restorers serialize create-only progress and retain one copy of every receipt',async()=>{
 const f=await fixture({extra:0}),results=await Promise.allSettled([step(f),step(f)]);
 assert.ok(results.some(result=>result.status==='fulfilled'));
 for(const result of results)if(result.status==='rejected')assert.match(result.reason.message,/journal-changed/);
 const final=await finish(f),m=await manifest(f);
 assert.equal(final.records,m.recordCount);
 assert.deepEqual((await quarantine(f).collection('operations').doc('sale_operation').get()).data().payload,
  (await f.root.collection('operations').doc('sale_operation').get()).data());
});

test('a changed authenticated-manifest body and byte/record limits cannot become accepted recovery evidence',async()=>{
 const f=await fixture({extra:0}),original=f.storage.objects.get(f.manifestKey),value=JSON.parse(original.toString());
 value.body.context.createdAtMs++;
 const changed=Buffer.from(canonical(value)),manifestSha256=createHash('sha256').update(changed).digest('hex'),
  manifestKey=`tenant-recovery/v1/${f.tenantId}/${f.imageId}/manifests/${manifestSha256}`;
 await f.storage.putImmutable(manifestKey,changed);
 await assert.rejects(()=>step(f,{manifestKey,manifestSha256,expected:{tenantId:f.tenantId,imageId:f.imageId}}),/authentication/);
 assert.equal((await db.doc('tenantRecoveryQuarantine/'+f.imageId).get()).exists,false);
 const tiny=new SyntheticTenantRecoveryStorage({maxBytes:32});
 await assert.rejects(()=>exportSyntheticTenantRecoveryImage({...f,storage:tiny,context:{...f.context,imageId:'tiny_'+f.imageId}}),/storage-limit/);
 const largeTenant='large_'+randomBytes(6).toString('hex'),root=db.doc('tenants/'+largeTenant);
 await root.create({enabled:true});await root.collection('audit').doc('large').create({note:'x'.repeat(750001)});
 await assert.rejects(()=>createSyntheticTenantRecoverySource({db,tenantId:largeTenant}),/string-limit|record-limit/);
});
