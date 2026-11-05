// Actual local Firestore queries; all fixtures and downstream stores are
// synthetic. No production storage/close/deletion acceptance is supplied.
import test,{after,before} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';import {initializeFirestore} from 'firebase-admin/firestore';
import {assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {createBoundedAnnualCatalog,createFirestoreAnnualCatalogAdapter} from '../src/annual-catalog.mjs';
import {ArchiveStateStore,SyntheticArchiveStateAdapter,FirestoreArchiveStateAdapter} from '../src/archive-state.mjs';
import {verifyOpeningDatePlan} from '../src/opening-date-policy.mjs';
import {firestorePreparationSource,prepareArchiveSourceStep,preparedArchiveSourceFactory} from '../src/archive-source-preparation.mjs';
import {runPreparedArchiveJob} from '../src/archive-prepared-job.mjs';
import {SyntheticArchiveStorage} from '../src/archive-storage.mjs';
import {hash} from '../src/validation.mjs';
const projectId='demo-strawberry-flutter';assertDemoOperatorEnvironment(projectId,process.env);
const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const app=initializeApp({projectId,credential:cert({project_id:projectId,
 client_email:'synthetic-annual-catalog@'+projectId+'.iam.gserviceaccount.com',
 private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()})},'annual-catalog-local');
const db=initializeFirestore(app,{preferRest:true});db.settings(emulatorFirestoreSettings(projectId,process.env));
const now=()=>Date.parse('2027-09-03T12:00:00Z');
const tenantId='catalog_fixture_a',other='catalog_fixture_b',party={id:'party',tenantId,kind:'merchant',name:'Synthetic Firestore party',openingMinor:1000,revision:1};
const entry={id:'sale',tenantId,kind:'sale',date:'2027-08-31',partyId:party.id,qtyMilli:1000,priceMinor:100,totalMinor:100,paidMinor:0,unit:'kg',grade:'A',revision:1};
const plan={policy:'dated-openings',tenantId,year:2026,checkpointSequence:2,reviewedByUid:'synthetic_owner',reviewedOn:'2027-09-03',dates:[{partyId:party.id,effectiveDate:'2026-09-01',partySha256:hash(party)}]};
const reserve={reserve:async()=>{}};
before(async()=>{
 const batch=db.batch();batch.create(db.doc('tenants/'+tenantId),{enabled:true,sequence:2});batch.create(db.doc('tenants/'+other),{enabled:true,sequence:0});
 batch.create(db.doc('tenants/'+tenantId+'/parties/'+party.id),party);
 batch.create(db.doc('tenants/'+tenantId+'/changes/0000000000000001'),{sequence:1,entity:'party',id:party.id,payload:party});
 batch.create(db.doc('tenants/'+tenantId+'/changes/0000000000000002'),{sequence:2,entity:'entry',id:entry.id,payload:entry});await batch.commit();
});
after(async()=>{await db.terminate();await deleteApp(app);});
test('actual Firestore stable-ID catalog pages and encrypted preparation preserve exact source scope/control totals',async()=>{
 const adapter=createFirestoreAnnualCatalogAdapter(db),catalog=createBoundedAnnualCatalog({adapter,budget:reserve,openingPlans:[plan],now,pageSize:1});
 const first=await catalog.page({limit:1});assert.equal(first.hasMore,true);assert.equal(first.tenants[0].tenantId,tenantId);assert.deepEqual(first.tenants[0].openingParties,[party]);
 const second=await catalog.page({afterTenant:tenantId,limit:1});assert.equal(second.hasMore,false);assert.equal(second.tenants[0].tenantId,other);
 const stateStore=new ArchiveStateStore(new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:2}}),{now});
 await stateStore.create({tenantId,year:2026,runId:'catalog_source'});const lease=await stateStore.acquire(tenantId,2026,'synthetic_runner');
 await stateStore.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true});
 const storage=new SyntheticArchiveStorage(),masterKey=Buffer.alloc(32,45),options={stateStore,tenantId,year:2026,lease,source:firestorePreparationSource(db),storage,masterKey,keyId:'synthetic_only',budget:reserve,now};
 try{
  assert.equal((await prepareArchiveSourceStep({...options,pageSize:1})).state,'preparing');assert.equal((await prepareArchiveSourceStep({...options,pageSize:1})).state,'prepared');
  const outcome=await runPreparedArchiveJob({...options,sourceFactory:preparedArchiveSourceFactory(options)});assert.equal(outcome.state,'verified');assert.equal(outcome.evidence.productionDurabilityAccepted,false);
  const projection=await preparedArchiveSourceFactory(options)({tenantId,year:2026,runId:'catalog_source',closingSequence:2,closingVersion:1,previousCloseHash:null,keyId:'synthetic_only',createdAtMs:now()});
  try{assert.equal((await projection.trustedControls()).signedReceivablesMinor,1100);}finally{await projection.destroy();}
  assert.equal((await db.doc('tenants/'+tenantId).get()).data().archivePolicy,undefined);
 }finally{masterKey.fill(0);}
});
test('real root mutation during party pagination and quota refusal fail before a financial close',async()=>{
 const adapter=createFirestoreAnnualCatalogAdapter(db),list=adapter.listOpeningParties;
 const racing={...adapter,listOpeningParties:async args=>{const rows=await list(args);await db.doc('tenants/'+tenantId).update({sequence:3});return rows;}};
 await assert.rejects(createBoundedAnnualCatalog({adapter:racing,budget:reserve,openingPlans:[plan],now,pageSize:1}).page({limit:1}),/snapshot-changed/);
 await db.doc('tenants/'+tenantId).update({sequence:2});let queries=0;
 const denied=createBoundedAnnualCatalog({adapter:{...adapter,listTenants:async()=>{queries++;throw Error('must-not-query');}},budget:{reserve:async()=>{throw Error('quota-denied');}},now});
 await assert.rejects(denied.page({limit:1}),/quota-denied/);assert.equal(queries,0);
 assert.equal((await db.doc('tenants/'+tenantId).get()).data().archivePolicy,undefined);
});
test('actual Firestore checkpoint, private preparation and verification resume safely after tenant deactivation',async()=>{
 const store=new ArchiveStateStore(new FirestoreArchiveStateAdapter(db),{now});
 await store.create({tenantId,year:2026,runId:'real_firestore_close'});
 const lease=await store.acquire(tenantId,2026,'private_test_runner');
 const evidence=verifyOpeningDatePlan({tenantId,year:2026,parties:[party],plan});
 const close=await store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true,openingDateEvidence:evidence});
 assert.equal(close.checkpoint.sequence,2);
 assert.equal((await db.doc('tenants/'+tenantId).get()).data().archivePolicy.closedThroughDate,'2027-09-01');
 assert.equal((await db.doc('tenants/'+other).get()).data().archivePolicy,undefined);
 const storage=new SyntheticArchiveStorage(),masterKey=Buffer.alloc(32,64);
 const options={stateStore:store,tenantId,year:2026,lease,source:firestorePreparationSource(db),storage,masterKey,keyId:'synthetic_only',budget:reserve,now};
 try{
  assert.equal((await prepareArchiveSourceStep(options)).state,'prepared');
  const before=[...storage.objects.keys()];
  await db.doc('tenants/'+tenantId).update({enabled:false});
  await assert.rejects(runPreparedArchiveJob({...options,sourceFactory:preparedArchiveSourceFactory(options)}),/tenant-not-active/);
  assert.deepEqual([...storage.objects.keys()],before);
  assert.equal((await store.read(tenantId,2026)).state,'checkpointed');
  await db.doc('tenants/'+tenantId).update({enabled:true});
  const result=await runPreparedArchiveJob({...options,sourceFactory:preparedArchiveSourceFactory(options)});
  assert.equal(result.state,'verified');assert.equal(result.evidence.productionDurabilityAccepted,false);
  const run=await store.read(tenantId,2026);
  assert.equal(run.evidence.verified.financialMatch,true);assert.equal(run.evidence.verified.identitiesMatch,true);
  assert.equal((await db.doc('tenants/'+tenantId).get()).data().archivePolicy.lastVerifiedYear,2026);
  assert.equal((await db.doc('tenants/'+tenantId+'/changes/0000000000000001').get()).exists,true);
  assert.equal((await db.doc('tenants/'+tenantId+'/parties/'+party.id).get()).exists,true);
 }finally{masterKey.fill(0);}
});
