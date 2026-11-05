import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
import {SyntheticArchiveStorage} from '../src/archive-storage.mjs';
import {prepareArchiveSourceStep,preparedArchiveSourceFactory} from '../src/archive-source-preparation.mjs';
import {runPreparedArchiveJob} from '../src/archive-prepared-job.mjs';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {createActiveSnapshotProjection} from '../src/active-snapshot-projection.mjs';
const tenantId='prepared_tenant',year=2026,time=Date.parse('2027-09-02T00:00:00Z');
async function fixture(count=111){
 const rows=[{sequence:1,entity:'party',id:'customer',payload:{id:'customer',tenantId,kind:'merchant',name:'Synthetic',openingMinor:0,revision:1}}];
 for(let i=2;i<=count;i++)rows.push({sequence:i,entity:'entry',id:'sale_'+i,payload:{id:'sale_'+i,tenantId,kind:'sale',partyId:'customer',partyName:'Synthetic',date:'2027-08-31',qtyMilli:1000,priceMinor:100,totalMinor:100,paidMinor:0,unit:'kg',grade:'A',revision:1}});
 const adapter=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:count}}),stateStore=new ArchiveStateStore(adapter,{now:()=>time});
 await stateStore.create({tenantId,year,runId:'prepared_run'});const lease=await stateStore.acquire(tenantId,year,'runner');await stateStore.checkpoint(tenantId,year,lease,{authorizedClose:true,exportEnabled:true});
 let reads=0;const source={readState:async()=>({enabled:true,sequence:count}),readChanges:async({afterSequence,limit})=>{reads++;return rows.slice(afterSequence,afterSequence+limit);}};
 const reservations=[],budget={reserve:async value=>{reservations.push(value);}},storage=new SyntheticArchiveStorage(),masterKey=randomBytes(32),keyId='test_key';
 return {stateStore,tenantId,year,lease,source,storage,masterKey,keyId,budget,now:()=>time,rows,reservations,reads:()=>reads};
}
async function prepare(f){let result;do{result=await prepareArchiveSourceStep({...f,pageSize:19});}while(result.state!=='prepared');return result;}
test('bounded encrypted source capture resumes without rereading the Firestore prefix; one streaming job verifies exact finance',async()=>{
 const f=await fixture();let result=await prepareArchiveSourceStep({...f,pageSize:19,maxNewPages:1});assert.equal(result.progress.sourceCursor,19);assert.equal(f.reads(),1);
 assert.equal(result.progress.pageCount,1);assert.equal(JSON.stringify(result.progress).includes('Synthetic'),false);
 for(const bytes of f.storage.objects.values())assert.equal(bytes.includes(Buffer.from('Synthetic')),false);
 await prepare(f);assert.equal(f.reads(),6);const priorReads=f.reads();
 const sourceFactory=preparedArchiveSourceFactory(f);const outcome=await runPreparedArchiveJob({...f,sourceFactory,chunkBytes:4096});
 assert.equal(outcome.state,'verified');assert.equal(outcome.evidence.financialMatch,true);assert.equal(f.reads(),priorReads);
 const run=await f.stateStore.read(tenantId,year);assert.equal(run.evidence.verified.productionDurabilityAccepted,false);
 assert.ok(run.exportProgress.chunks.length>4);assert.equal(run.evidence.verified.identitiesMatch,true);
 assert.equal((await runPreparedArchiveJob({...f,sourceFactory})).state,'verified');
});
test('wrong key, gap, cross-tenant and denied quota cannot advance a captured source',async()=>{
 const f=await fixture(40);await prepareArchiveSourceStep({...f,pageSize:10});const before=await f.stateStore.read(tenantId,year),objects=f.storage.objects.size;
 await assert.rejects(prepareArchiveSourceStep({...f,masterKey:randomBytes(32)}),/authentication/);
 assert.equal(f.storage.objects.size,objects);assert.deepEqual((await f.stateStore.read(tenantId,year)).sourcePreparation,before.sourcePreparation);
 await assert.rejects(prepareArchiveSourceStep({...f,budget:{reserve:async()=>{throw Error('denied');}}}),/denied/);assert.equal(f.storage.objects.size,objects);
 const original=f.rows[10];f.rows[10]={...original,payload:{...original.payload,tenantId:'wrong'}};
 await assert.rejects(prepareArchiveSourceStep(f),/scope/);f.rows[10]={...original,sequence:12};await assert.rejects(prepareArchiveSourceStep(f),/scope/);
});
test('lost publication retries orphan uploads safely, tampered captured pages and unbranded factories fail closed',async()=>{
 const f=await fixture(20);let fail=true;const persist=f.stateStore.recordSourcePreparation.bind(f.stateStore);
 f.stateStore.recordSourcePreparation=async(...args)=>{if(args[3].pageCount===1&&fail){fail=false;throw Error('crash-after-upload');}return persist(...args);};
 await assert.rejects(prepareArchiveSourceStep({...f,pageSize:10}),/crash-after-upload/);assert.equal((await f.stateStore.read(tenantId,year)).sourcePreparation.sourceCursor,0);
 await prepare(f);const sourceFactory=preparedArchiveSourceFactory(f);const run=await f.stateStore.read(tenantId,year),head=run.sourcePreparation.head;
 f.storage.objects.get(head.key)[20]^=1;
 await assert.rejects(sourceFactory({tenantId,year,runId:'prepared_run',closingSequence:20,closingVersion:1,previousCloseHash:null,keyId:f.keyId,createdAtMs:time}),/integrity/);
 await assert.rejects(runPreparedArchiveJob({...f,sourceFactory:async()=>{}}),/prepared-source/);
});
test('job crash resumes durable prefix with no duplicate output or source query',async()=>{
 const f=await fixture(70);await prepare(f);const sourceFactory=preparedArchiveSourceFactory(f),put=f.storage.putImmutable.bind(f.storage);let annualWrites=0;
 f.storage.putImmutable=async(k,b)=>{if(++annualWrites===3)throw Error('upload-interrupted');return put(k,b);};
 await assert.rejects(runPreparedArchiveJob({...f,sourceFactory,chunkBytes:4096}),/upload-interrupted/);
 const before=await f.stateStore.read(tenantId,year);assert.ok(before.exportProgress.chunks.length>=1);assert.equal(before.state,'exporting');
 f.storage.putImmutable=put;assert.equal((await runPreparedArchiveJob({...f,sourceFactory,chunkBytes:4096})).state,'verified');
 assert.equal(f.reads(),4);
});
test('runtime budget interrupts source reconstruction before export and resumes from the protected preparation',async()=>{
 const f=await fixture(400);await prepare(f);const before=await f.stateStore.read(tenantId,year),objects=f.storage.objects.size;
 const sourceFactory=preparedArchiveSourceFactory(f),read=f.storage.read.bind(f.storage);let elapsed=0,reads=0;
 f.storage.read=async(...args)=>{reads++;const value=await read(...args);elapsed+=250;return value;};
 const deferred=await runPreparedArchiveJob({...f,sourceFactory,maxRuntimeMs:1000,now:()=>time+elapsed});
 assert.deepEqual({state:deferred.state,reason:deferred.reason},{state:'deferred',reason:'runtime-budget'});
 assert.equal(reads,4);assert.equal(f.storage.objects.size,objects);
 const after=await f.stateStore.read(tenantId,year);assert.equal(after.state,'checkpointed');assert.deepEqual(after.sourcePreparation,before.sourcePreparation);assert.equal(after.exportProgress,undefined);
 f.storage.read=read;
 assert.equal((await runPreparedArchiveJob({...f,sourceFactory})).state,'verified');
});
test('long source reconstruction renews its lease and a read past expiry cannot publish',async()=>{
 const f=await fixture(61);await prepare(f);let elapsed=0,renewals=0;
 f.stateStore.now=()=>time+elapsed;
 const renew=f.stateStore.renew.bind(f.stateStore),read=f.storage.read.bind(f.storage);
 f.stateStore.renew=async(...args)=>{renewals++;return renew(...args);};
 f.storage.read=async(...args)=>{const value=await read(...args);elapsed+=5000;return value;};
 const outcome=await runPreparedArchiveJob({...f,sourceFactory:preparedArchiveSourceFactory(f),now:()=>time+elapsed,maxRuntimeMs:300_000});
 assert.equal(outcome.state,'verified');assert.ok(renewals>0);assert.ok(outcome.lease.expiresAtMs>f.lease.expiresAtMs);
 const expired=await fixture(61);await prepare(expired);let lost=0;expired.stateStore.now=()=>time+lost;
 const original=expired.storage.read.bind(expired.storage),objects=expired.storage.objects.size;
 expired.storage.read=async(...args)=>{const value=await original(...args);lost+=61000;return value;};
 await assert.rejects(runPreparedArchiveJob({...expired,sourceFactory:preparedArchiveSourceFactory(expired),now:()=>time+lost,maxRuntimeMs:300_000}),/stale-archive-lease/);
 assert.equal(expired.storage.objects.size,objects);assert.equal((await expired.stateStore.read(tenantId,year)).state,'checkpointed');
});
test('projection yields cooperatively during ingest, controls and annual-record scans without changing finance',async()=>{
 const f=await fixture(400),context={tenantId,year,runId:'projection_progress',closingSequence:400,closingVersion:1,previousCloseHash:null,keyId:f.keyId,createdAtMs:time};
 let phase='ingest',calls=0,stop=false,emittedEntries=0;
 const projection=await createArchiveProjection({context,beforeWork:async()=>{calls++;if(stop&&((phase==='controls'&&calls>=2)||(phase==='records'&&emittedEntries>=128)))throw Error('synthetic-runtime-stop');}});
 try{
  await projection.ingest(f.rows);assert.ok(calls>=4);
  phase='controls';calls=0;stop=true;
  await assert.rejects(projection.trustedControls(),/synthetic-runtime-stop/,phase);
  stop=false;const controls=await projection.trustedControls();assert.equal(controls.signedReceivablesMinor,39900);
  phase='records';calls=0;stop=true;
  await assert.rejects(async()=>{for await(const row of projection.records())if(row.type==='entry')emittedEntries++;},/synthetic-runtime-stop/,phase);
  assert.ok(emittedEntries>=128&&emittedEntries<256);
  stop=false;let entries=0;for await(const row of projection.records())if(row.type==='entry')entries++;
  assert.equal(entries,399);
 }finally{await projection.destroy();}
});
test('verified seed copying also obeys cooperative runtime checkpoints',async()=>{
 const f=await fixture(400),seed=await createActiveSnapshotProjection({scope:{snapshotId:'runtime_seed',tenantId,uid:'manager',role:'manager',membershipEpoch:1,checkpointSequence:400,historyFloor:0}});
 try{
  await seed.ingest(f.rows);let checkpoints=0;
  await assert.rejects(createArchiveProjection({context:{tenantId,year,runId:'seed_runtime',closingSequence:400},seed,beforeWork:async()=>{if(++checkpoints===3)throw Error('seed-runtime-stop');}}),/seed-runtime-stop/);
  assert.equal(checkpoints,3);
 }finally{await seed.destroy();}
});
test('tenant disablement or deletion after capture blocks preparation and publication',async()=>{
 for(const mutation of [{enabled:false},{adminDeleting:true}]){
  const f=await fixture(20);await prepare(f);
  const root=f.stateStore.adapter.roots.get(tenantId);Object.assign(root,mutation);
  const objects=f.storage.objects.size;
  await assert.rejects(prepareArchiveSourceStep(f),/tenant-not-active/);
  await assert.rejects(runPreparedArchiveJob({...f,sourceFactory:preparedArchiveSourceFactory(f)}),/tenant-not-active/);
  assert.equal(f.storage.objects.size,objects);assert.equal((await f.stateStore.read(tenantId,year)).manifest,undefined);
 }
});
