// Guarded, disposable emulator acceptance for the real Firestore transaction
// adapter. This is not production storage, recovery or cleanup acceptance.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {DEMO_PROJECT_ID,assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';
import {createActiveSnapshotProjection} from '../src/active-snapshot-projection.mjs';
import {createActiveSnapshotPackage} from '../src/active-snapshot-service.mjs';
import {snapshotHash} from '../src/active-snapshot-format.mjs';
import {FirestoreFeedPruneAdapter,immutableFeedDocumentsForPlan,createFeedPrunePlan,verifyFeedPrunePlan,runFeedPruneStep} from '../src/feed-pruner.mjs';

// BOTH services/project identities are checked before initializing any SDK.
assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
// Fresh in-memory synthetic credentials prevent default-credential discovery.
// No real service account is created and no private material is logged/saved.
const sessionKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert({projectId:DEMO_PROJECT_ID,clientEmail:`synthetic-pruner@${DEMO_PROJECT_ID}.iam.gserviceaccount.com`,privateKey:sessionKey})},'synthetic-feed-pruner'),db=getFirestore(app),ownedRoots=new Set();
const C=25,year=2026,time=Date.parse('2027-12-01T00:00:00Z');
const docId=sequence=>String(sequence).padStart(16,'0');
const sale=(tenantId,id)=>({id,tenantId,kind:'sale',partyId:'party',partyName:'Synthetic merchant',qtyMilli:1000,priceMinor:501,totalMinor:501,paidMinor:0,unit:'kg',grade:'A',date:'2027-08-31',note:'',creatorUid:'synthetic_manager',revision:1});
async function all(iterable){const rows=[];for await(const row of iterable)rows.push(row);return rows;}

after(async()=>{
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
 for(const tenantId of ownedRoots){assert.match(tenantId,/^synthetic_pruner_[a-z_]+$/);await db.recursiveDelete(db.doc(`tenants/${tenantId}`));}
 await deleteApp(app);
});

async function fixture(t,suffix){
 const tenantId=`synthetic_pruner_${suffix}`,root=db.doc(`tenants/${tenantId}`),runId=`annual_${suffix}`;
 assert.equal((await root.get()).exists,false,'Fixture must own a new disposable tenant');
 const rows=[];
 for(let sequence=1;sequence<=C+2;sequence++){
  const entity=sequence===1?'party':'entry',id=sequence===1?'party':`entry_${sequence}`;
  const payload=entity==='party'?{id,tenantId,name:'Synthetic merchant',kind:'merchant',phone:'',openingMinor:0,favorite:false,revision:1}:sale(tenantId,id);
  rows.push({entity,id,payload,sequence,acceptedAtMs:time-1_000_000+sequence,closeVersion:1});
 }
 const batch=db.batch();batch.create(root,{enabled:true,sequence:C+2,historyFloor:0,minimumSyncProtocol:1,archivePolicy:{pendingFeedConsumers:[]}});
 for(const row of rows){
  batch.set(root.collection('changes').doc(docId(row.sequence)),row);
  batch.set(root.collection(row.entity==='entry'?'entries':'parties').doc(row.id),row.payload);
  batch.set(root.collection('operations').doc(`receipt_${row.sequence}`),{digest:snapshotHash(row),result:{status:'accepted',sequence:row.sequence}});
 }
 batch.set(root.collection('employeeChanges').doc(docId(1)),{...rows[0],uid:'all',payload:{id:'party',tenantId,name:'Synthetic merchant',kind:'merchant',phone:'',favorite:false,revision:1}});
 await batch.commit();
 // Own cleanup only after this atomic create succeeds. A rejected fixture must
 // never recursively delete a pre-existing synthetic tenant it did not create.
 ownedRoots.add(tenantId);
 const reservations=[],budget={reserve:async request=>reservations.push(structuredClone(request))};
 const source=await all(immutableFeedDocumentsForPlan(db,{tenantId,fromSequence:0,checkpointSequence:C,budget,pageSize:10}));
 assert.equal(source.length,C);assert.ok(source.every(row=>Number.isSafeInteger(row.updateTime.seconds)&&Number.isSafeInteger(row.updateTime.nanoseconds)));
 const projection=await createActiveSnapshotProjection({scope:{snapshotId:`snapshot_${suffix}`,tenantId,uid:'synthetic_manager',role:'manager',membershipEpoch:1,checkpointSequence:C,historyFloor:0}});
 t.after(()=>projection.destroy());await projection.ingest(source.map(row=>row.data));
 const snapshotObjects=new Map();
 const snapshot=await createActiveSnapshotPackage({projection,budget,writePage:async(index,bytes)=>{const key=`snapshot/${index}`;snapshotObjects.set(key,Buffer.from(bytes));return {key};}});
 assert.equal(snapshot.header.checkpointSequence,C);assert.equal(snapshot.header.recordCount,C);assert.ok(snapshotObjects.size>0);
 const planObjects=new Map();
 const saved=await createFeedPrunePlan({projection,tenantId,year,runId,snapshotHeaderSha256:snapshot.headerSha256,source,writePage:async({index,bytes})=>{const key=`plan/${index}`;assert.equal(planObjects.has(key),false);planObjects.set(key,Buffer.from(bytes));return key;},budget});
 const verify=()=>verifyFeedPrunePlan({manifest:saved.manifest,expectedSha256:saved.sha256,readPage:async(key,{maxBytes})=>{const bytes=planObjects.get(key);assert.ok(bytes.length<=maxBytes);return bytes;},budget});
 const lease={owner:'synthetic_operator',fence:1,expiresAtMs:time+300_000},manifestSha256=snapshotHash(`synthetic annual package ${tenantId}`);
 await root.collection('archiveRuns').doc(String(year)).set({tenantId,year,runId,state:'cleanup_pending',checkpoint:{sequence:C,version:1},lease,manifest:{sha256:manifestSha256},
  evidence:{verified:{financialMatch:true,identitiesMatch:true,manifestSha256,closingSequence:C,closingVersion:1,verifiedAtMs:time-91*86_400_000},
   activeSnapshot:{headerSha256:snapshot.headerSha256,checkpointSequence:C,fromSequence:0,sourceDocumentHashesSha256:projection.sourceDocumentHashesSha256,verified:true},
   cleanupAcceptance:{planSha256:saved.sha256,snapshotHeaderSha256:snapshot.headerSha256,manifestSha256,closingSequence:C,closingVersion:1,synthetic:true,independentRecovery:true,keyRecoveryTested:true,retentionChecked:true,dependenciesResolved:true,protocolAcceptance:true,clientInstallAcceptance:true}}});
 const freshAdapter=()=>{
  const firestoreAdapter=new FirestoreFeedPruneAdapter(db);
  // The runner's explicit synthetic boundary is preserved. Only the underlying
  // transaction implementation is real; no production flags are fabricated.
  return Object.freeze({kind:'synthetic',transaction:firestoreAdapter.transaction.bind(firestoreAdapter)});
 };
 const run=async({adapter=freshAdapter(),plan=null,...overrides}={})=>runFeedPruneStep({adapter,tenantId,year,lease,plan:plan??await verify(),budget,storage:{kind:'synthetic',productionDurabilityAccepted:false},config:{cleanupEnabled:true,graceDays:90},mode:'synthetic',now:()=>time,...overrides});
 return {tenantId,root,rows,budget,reservations,lease,verify,freshAdapter,run};
}

async function retained(root){
 const [entries,parties,receipts,employee]=await Promise.all(['entries','parties','operations','employeeChanges'].map(name=>root.collection(name).orderBy('__name__').get()));
 return {entries:entries.docs.map(doc=>({id:doc.id,data:doc.data()})),parties:parties.docs.map(doc=>({id:doc.id,data:doc.data()})),receipts:receipts.docs.map(doc=>({id:doc.id,data:doc.data()})),employee:employee.docs.map(doc=>({id:doc.id,data:doc.data()}))};
}

test('real Firestore transaction commits first20, resumes with a new adapter/verified plan and retains post-C financial facts/receipts/employee feed',async t=>{
 const f=await fixture(t,'lifecycle'),before=await retained(f.root),first=await f.run();
 assert.equal(first.state,'pruning');assert.equal(first.deleted,20);assert.equal(first.page,1);
 const rootAfterFirst=(await f.root.get()).data(),runAfterFirst=(await f.root.collection('archiveRuns').doc(String(year)).get()).data();
 assert.equal(rootAfterFirst.historyFloor,C);assert.equal(rootAfterFirst.minimumSyncProtocol,2);assert.equal(runAfterFirst.pruneProgress.deleted,20);
 assert.equal((await f.root.collection('changes').get()).size,7);
 assert.equal((await f.root.collection('changes').doc(docId(20)).get()).exists,false);assert.equal((await f.root.collection('changes').doc(docId(21)).get()).exists,true);
 // A new writer advances the shared root after the first prune transaction.
 const newSequence=C+3,payload=sale(f.tenantId,'new_trade'),batch=db.batch();
 batch.update(f.root,{sequence:newSequence});batch.set(f.root.collection('changes').doc(docId(newSequence)),{entity:'entry',id:payload.id,payload,sequence:newSequence,acceptedAtMs:time,closeVersion:1});
 batch.set(f.root.collection('entries').doc(payload.id),payload);batch.set(f.root.collection('operations').doc('receipt_new_trade'),{result:{status:'accepted',sequence:newSequence}});await batch.commit();
 const next=await f.run({adapter:f.freshAdapter(),plan:await f.verify()});assert.equal(next.state,'complete');assert.equal(next.deleted,C);assert.equal(next.page,2);
 assert.deepEqual((await f.root.collection('changes').orderBy('sequence').get()).docs.map(doc=>doc.data().sequence),[C+1,C+2,C+3]);
 const after=await retained(f.root);assert.equal(after.entries.length,before.entries.length+1);assert.equal(after.receipts.length,before.receipts.length+1);
 for(const old of before.entries)assert.deepEqual(after.entries.find(row=>row.id===old.id),old);
 for(const old of before.receipts)assert.deepEqual(after.receipts.find(row=>row.id===old.id),old);
 assert.deepEqual(after.parties,before.parties);assert.deepEqual(after.employee,before.employee);
 assert.equal((await f.root.get()).data().sequence,C+3);
 assert.equal((await f.run()).state,'complete');assert.equal((await f.root.collection('changes').get()).size,3);
});

test('real Firestore rollback rejects a changed candidate before its firstbatch with floor/cursor/feed and retained facts unchanged',async t=>{
 const f=await fixture(t,'changed_body'),before=await retained(f.root);
 await f.root.collection('changes').doc(docId(10)).update({'payload.note':'changed after verified plan'});
 const changeCount=(await f.root.collection('changes').get()).size;
 await assert.rejects(()=>f.run(),/prune-document-changed/);
 const root=(await f.root.get()).data(),run=(await f.root.collection('archiveRuns').doc(String(year)).get()).data();
 assert.equal(root.historyFloor,0);assert.equal(root.minimumSyncProtocol,1);assert.equal(run.state,'cleanup_pending');assert.equal(run.pruneProgress,undefined);
 assert.equal((await f.root.collection('changes').get()).size,changeCount);assert.deepEqual(await retained(f.root),before);
});

test('real Firestore rollback rejects provider-version-only mutation and runtime deletion fence before deleting remaining rows',async t=>{
 const f=await fixture(t,'version_and_gate');await f.run();
 const candidate=f.root.collection('changes').doc(docId(22)),old=await candidate.get();
 await candidate.update({syntheticTransientVersionTouch:true});await candidate.set(old.data());
 const updated=await candidate.get();assert.deepEqual(updated.data(),old.data());assert.equal(updated.updateTime.isEqual(old.updateTime),false);
 await assert.rejects(()=>f.run(),/prune-document-changed/);
 assert.equal((await f.root.collection('changes').get()).size,7);assert.equal((await f.root.collection('archiveRuns').doc(String(year)).get()).data().pruneProgress.deleted,20);
 await f.root.update({adminDeleting:true});
 await assert.rejects(()=>f.run(),/tenant-not-active/);
 assert.equal((await f.root.collection('changes').get()).size,7);assert.equal((await f.root.get()).data().historyFloor,C);
});

test('real Firestore consumer guard blocks same and later checkpoints as well as earlier source consumers',async t=>{
 const f=await fixture(t,'consumers'),adapter=new FirestoreFeedPruneAdapter(db),consumer=f.root.collection('archiveRuns').doc('2027');
 for(const state of ['checkpointed','exporting','uploaded'])for(const sequence of [C-1,C,C+2]){
  await consumer.set({tenantId:f.tenantId,year:2027,runId:'dependent_export',state,checkpoint:{sequence,version:2}});
  // Direct read-only guard invocation exercises the actual production adapter
  // query without pretending synthetic storage has production acceptance.
  await assert.rejects(()=>adapter.transaction(f.tenantId,year,tx=>tx.assertNoPendingFeedConsumers()),/dependent-export-in-progress/,`${state} at ${sequence}`);
  await assert.rejects(()=>f.run(),/dependent-export-in-progress/,`deleting runner blocked: ${state} at ${sequence}`);
  assert.equal((await f.root.collection('changes').get()).size,C+2);assert.equal((await f.root.get()).data().historyFloor,0);
 }
 await consumer.update({state:'verified'});
 await adapter.transaction(f.tenantId,year,tx=>tx.assertNoPendingFeedConsumers());
});
