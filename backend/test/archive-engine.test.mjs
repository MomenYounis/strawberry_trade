import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {cairoDate,financialYearForDate,eligibleYears,selectArchiveYears,ARCHIVE_DEFAULTS} from '../src/archive-calendar.mjs';
import {ArchiveStateStore,SyntheticArchiveStateAdapter,cleanupBlockers} from '../src/archive-state.mjs';
import {ArchiveControlReader,immutableChangesAtCheckpoint} from '../src/archive-accounting.mjs';
import {exportArchive,readArchiveManifest,readArchiveChunk,verifyArchive} from '../src/archive-format.mjs';
import {SyntheticArchiveStorage,R2ArchiveStorage,createTemporaryRestoreSink} from '../src/archive-storage.mjs';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {runArchiveExportStep} from '../src/archive-coordinator.mjs';
import {canonical} from '../src/validation.mjs';

const tenantId='synthetic_archive_tenant';
const due=Date.parse('2027-09-01T00:00:00Z');
const key=randomBytes(32);
const context=(year=2026,sequence=3)=>({tenantId,year,runId:`synthetic_run_${year}`,closingSequence:sequence,closingVersion:year-2025,previousCloseHash:null,keyId:'synthetic_only',createdAtMs:due});
const party=(id,kind='merchant',openingMinor=0)=>({id,tenantId,kind,name:'Synthetic '+id,openingMinor,revision:1});
const invoice=(id,kind='sale',date='2027-08-31',partyId='customer')=>({id,tenantId,kind,date,partyId,partyName:'Synthetic',qtyMilli:10000,priceMinor:200000,totalMinor:2000000,paidMinor:0,grade:'A',unit:'kg',revision:1});
const payment=(id,kind='merchant_payment',date='2027-09-02',partyId='customer')=>({id,tenantId,kind,date,partyId,totalMinor:500000,paidMinor:500000,revision:1});
const change=(sequence,entity,payload)=>({sequence,entity,id:payload.id,payload});
async function makeProjection(changes,c=context(2026,changes.length)){
  const projection=await createArchiveProjection({context:c});try{await projection.ingest(changes);return projection;}catch(error){await projection.destroy();throw error;}
}
async function packageFixture(changes=[change(1,'party',party('customer')),change(2,'entry',invoice('sale'))],opts={}) {
  const c=context(2026,changes.length),projection=await makeProjection(changes,c),storage=new SyntheticArchiveStorage();
  try{const trustedControls=await projection.trustedControls(),result=await exportArchive({storage,masterKey:key,context:c,records:projection.records(),trustedControls,assertLease:async()=>{},...opts});return {c,storage,trustedControls,...result};}finally{await projection.destroy();}
}
async function manifest(fixture,masterKey=key){return readArchiveManifest({storage:fixture.storage,manifestKey:fixture.manifestKey,manifestSha256:fixture.manifestSha256,masterKey,expected:fixture.c});}

test('Cairo civil first financial year, half-open boundary, DST and leap day',()=>{
  assert.equal(cairoDate(Date.parse('2027-08-31T20:59:59.999Z')),'2027-08-31');
  assert.deepEqual(eligibleYears(Date.parse('2027-08-31T20:59:59.999Z')),[]);
  assert.deepEqual(eligibleYears(Date.parse('2027-08-31T21:00:00Z')),[2026]);
  assert.equal(cairoDate(Date.parse('2026-10-31T22:00:00Z')),'2026-11-01');
  assert.equal(financialYearForDate('2028-02-29'),2027);
  assert.equal(financialYearForDate('2027-09-01'),2027);
  assert.throws(()=>financialYearForDate('2027-02-29'));
  assert.deepEqual(eligibleYears(Date.parse('2026-09-01T00:00:00Z')),[]);
  assert.equal(ARCHIVE_DEFAULTS.schedulerEnabled,false);assert.equal(ARCHIVE_DEFAULTS.cleanupEnabled,false);
});
test('missed unstarted backlog requires explicit ordered selection, existing run recovers',()=>{
  const serverTimeMs=Date.parse('2029-09-02T00:00:00Z');
  assert.deepEqual(selectArchiveYears({serverTimeMs}).years,[]);
  assert.deepEqual(selectArchiveYears({serverTimeMs}).backlogRequiringSelection,[2026,2027]);
  assert.throws(()=>selectArchiveYears({serverTimeMs,selectedYears:[2028],administratorSelection:true}),/previous-close/);
  assert.throws(()=>selectArchiveYears({serverTimeMs,selectedYears:[2026]}),/administrator/);
  assert.deepEqual(selectArchiveYears({serverTimeMs,selectedYears:[2028,2026,2027],administratorSelection:true}).years,[2026,2027,2028]);
  assert.deepEqual(selectArchiveYears({serverTimeMs,existing:[{year:2026,runId:'recovery',state:'exporting'}]}).years,[2026]);
});
test('persisted fenced close is once only; expired worker cannot checkpoint/publish/advance',async()=>{
  let time=due;const adapter=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:21}}),store=new ArchiveStateStore(adapter,{now:()=>time});
  await store.create({tenantId,year:2026,runId:'run'});const old=await store.acquire(tenantId,2026,'old',1000);
  await assert.rejects(()=>store.checkpoint(tenantId,2026,old),/disabled/);
  const closed=await store.checkpoint(tenantId,2026,old,{authorizedClose:true,exportEnabled:true});
  assert.equal(closed.checkpoint.sequence,21);assert.equal(closed.checkpoint.version,1);
  time+=1001;const restarted=new ArchiveStateStore(adapter,{now:()=>time}),fresh=await restarted.acquire(tenantId,2026,'new');
  await assert.rejects(()=>store.checkpoint(tenantId,2026,old,{authorizedClose:true,exportEnabled:true}),/stale/);
  assert.equal((await restarted.checkpoint(tenantId,2026,fresh,{authorizedClose:true,exportEnabled:true})).checkpoint.version,1);
  await assert.rejects(()=>store.advance(tenantId,2026,old,'checkpointed','exporting'),/stale/);
  await assert.rejects(()=>store.publishManifest(tenantId,2026,old,{key:'manifest',sha256:'a'.repeat(64)}),/stale/);
  assert.equal(adapter.roots.get(tenantId).archivePolicy.closedThroughDate,'2027-09-01');
  assert.equal(adapter.roots.get(tenantId).sequence,21);
});
test('synthetic storage and plausible verification can never satisfy deletion gates',()=>{
  const blockers=cleanupBlockers({config:{cleanupEnabled:true,graceDays:90},storage:new SyntheticArchiveStorage(),now:due,
    independentRecovery:true,keyRecoveryTested:true,retentionChecked:true,dependenciesResolved:true,protocolAcceptance:true,productionAcceptance:true});
  assert(blockers.includes('durable-storage-not-accepted'));assert(blockers.includes('pruner-not-implemented'));
});
test('authoritative SQLite controls independently agree; customer/supplier 20000 to 15000 continuity',async()=>{
  const changes=[change(1,'party',party('customer')),change(2,'party',party('supplier','supplier')),
    change(3,'entry',invoice('sale')),change(4,'entry',invoice('purchase','purchase','2027-08-31','supplier')),
    change(5,'entry',payment('receipt')),change(6,'entry',payment('pay_supplier','supplier_payment','2027-09-02','supplier'))];
  for(const year of [2026,2027]){
    const p=await makeProjection(changes,context(year,6));try{
      const expected=await p.trustedControls(),reader=new ArchiveControlReader(context(year,6));for await(const row of p.records())reader.accept(row);
      assert.deepEqual(reader.finish(),expected);assert.equal(expected.signedReceivablesMinor,year===2026?2000000:1500000);assert.equal(expected.signedPayablesMinor,year===2026?2000000:1500000);
      if(year===2027){assert.equal(expected.accounts.find(a=>a.role==='merchant').openingMinor,2000000);assert.equal(expected.accounts.find(a=>a.role==='merchant').periodMinor,-500000);}
    }finally{await p.destroy();}
  }
});
test('signed advances, adjustment, expenses, partial return and reversal use dated effects',async()=>{
  const sale=invoice('sale'),ret={...sale,id:'return',kind:'sale_return',date:'2027-09-03',originalId:'sale',qtyMilli:2500,totalMinor:500000};
  const changes=[change(1,'party',party('customer','merchant',-100000)),change(2,'entry',sale),change(3,'entry',ret),
    change(4,'entry',{id:'adjust',tenantId,kind:'balance_adjustment',partyId:'customer',date:'2027-09-04',totalMinor:10000,paidMinor:0,note:'Synthetic adjustment',adjustmentDirection:'decrease'}),
    change(5,'entry',{id:'reversal',tenantId,kind:'reversal',originalId:'return',date:'2027-09-05',note:'Synthetic reversal'}),
    change(6,'entry',{id:'expense',tenantId,kind:'expense_business',date:'2027-09-06',totalMinor:7000,paidMinor:7000,category:'Other'})];
  const p=await makeProjection(changes,context(2027,6));try{const expected=await p.trustedControls(),reader=new ArchiveControlReader(context(2027,6));for await(const row of p.records())reader.accept(row);assert.deepEqual(reader.finish(),expected);assert.equal(expected.signedReceivablesMinor,1890000);assert.equal(expected.periodRecordedCashMinor,-7000);assert.equal(expected.counts.reference,1);}finally{await p.destroy();}
});
test('salary obligations retain original salary month and pending submissions remain nonfinancial',async()=>{
  const changes=[change(1,'employee',{id:'employee',tenantId,name:'Synthetic',active:true}),
    change(2,'salary_term',{id:'term',tenantId,employeeId:'employee',effectiveMonth:'2027-07',monthlyMinor:100000}),
    change(3,'submission',{id:'pending',tenantId,employeeId:'employee',creatorUid:'employee_uid',recordedByUid:'employee_uid',recordedAtMs:1,kind:'expense_business',date:'2027-08-31',amountMinor:99999,status:'pending'}),
    change(4,'entry',{id:'payroll',tenantId,kind:'payroll',employeeId:'employee',salaryMonth:'2027-07',date:'2027-08-10',totalMinor:25000,paidMinor:25000})];
  const p=await makeProjection(changes,context(2026,4));try{const expected=await p.trustedControls(),reader=new ArchiveControlReader(context(2026,4));for await(const row of p.records())reader.accept(row);assert.deepEqual(reader.finish(),expected);assert.equal(expected.pendingSubmissions,1);assert.equal(expected.periodRecordedCashMinor,-25000);assert.deepEqual(expected.payrollObligations.map(o=>o.balanceMinor),[75000,100000]);}finally{await p.destroy();}
});
test('immutable source rejects gaps, cross-tenant payloads and rewritten entries',async()=>{
  await assert.rejects(()=>makeProjection([change(2,'party',party('customer'))],context(2026,2)),/sequence-gap/);
  await assert.rejects(()=>makeProjection([change(1,'party',{...party('customer'),tenantId:'wrong'})],context(2026,1)),/source-change/);
  await assert.rejects(()=>makeProjection([change(1,'party',party('customer')),change(2,'entry',invoice('same')),change(3,'entry',invoice('same'))]),/rewritten/);
});
test('strict mixed-year/mixed-tenant/unsafe-integer records block export',async()=>{
  const c=context(),reader=new ArchiveControlReader(c);
  assert.throws(()=>reader.accept({type:'entry',tenantId,year:2026,sequence:1,payload:invoice('wrong','sale','2027-09-01')}),/mixed/);
  assert.throws(()=>reader.accept({type:'entry',tenantId:'other',year:2026,sequence:1,payload:invoice('wrong')}),/mixed/);
  assert.throws(()=>reader.accept({type:'opening',tenantId,year:2026,sequence:0,payload:{id:'customer',role:'merchant',balanceMinor:Number.MAX_SAFE_INTEGER+1}}));
});
test('re-download authenticates exact bytes; repeated restore creates no live postings',async()=>{
  const f=await packageFixture();const originalObjects=f.storage.objects.size;
  for(let i=0;i<3;i++){
    const evidence=await verifyArchive({storage:f.storage,manifestKey:f.manifestKey,manifestSha256:f.manifestSha256,masterKey:key,expected:f.c,trustedControls:f.trustedControls,sink:await createTemporaryRestoreSink(),now:()=>due});
    assert.equal(evidence.financialMatch,true);assert.equal(evidence.productionDurabilityAccepted,false);
  }
  assert.equal(f.storage.objects.size,originalObjects);
  const m=await manifest(f);assert(Object.isFrozen(m));assert(Object.isFrozen(m.chunks));
  await assert.rejects(()=>readArchiveChunk({storage:f.storage,manifest:{...m},masterKey:key,index:0}),/authenticated/);
});
test('wrong key, tenant, checkpoint and corrupted ciphertext fail closed',async()=>{
  const f=await packageFixture();await assert.rejects(()=>manifest(f,randomBytes(32)),/authentication/);
  await assert.rejects(()=>readArchiveManifest({...f,masterKey:key,expected:{tenantId:'other',year:2026}}));
  await assert.rejects(()=>readArchiveManifest({...f,masterKey:key,expected:{...f.c,closingSequence:99}}),/identity/);
  const m=await manifest(f),chunk=m.chunks[0];f.storage.objects.get(chunk.key)[15]^=1;
  await assert.rejects(()=>readArchiveChunk({storage:f.storage,manifest:m,masterKey:key,index:0}),/integrity/);
});
test('tampered/noncanonical/invalid UTF8 manifests and traversal rejected',async()=>{
  const f=await packageFixture(),valid=Buffer.from(f.storage.objects.get(f.manifestKey));
  for(const bytes of [Buffer.from(valid.toString().replace('AES-256','AES-128')),Buffer.concat([Buffer.from(' '),valid]),Buffer.from([0x7b,0xff,0x7d])]){
    const hash=createHash('sha256').update(bytes).digest('hex'),keyPath=f.manifestKey.slice(0,-64)+hash;f.storage.objects.set(keyPath,bytes);
    await assert.rejects(()=>readArchiveManifest({storage:f.storage,manifestKey:keyPath,manifestSha256:hash,masterKey:key,expected:f.c}));
  }
  await assert.rejects(()=>readArchiveManifest({storage:f.storage,manifestKey:f.manifestKey.replace('/2026/','/2026/../'),manifestSha256:f.manifestSha256,masterKey:key,expected:f.c}),/path/);
});
test('partial chunk upload resumes by source hash and fails changed prefix',async()=>{
  const changes=[change(1,'party',party('customer')),...Array.from({length:12},(_,i)=>change(i+2,'entry',{...invoice('sale_'+i),note:'x'.repeat(300)}))],c=context(2026,changes.length),projection=await makeProjection(changes,c),storage=new SyntheticArchiveStorage();let progress;
  try{const trustedControls=await projection.trustedControls();await assert.rejects(()=>exportArchive({storage,masterKey:key,context:c,records:projection.records(),trustedControls,chunkBytes:1024,assertLease:async()=>{},onCheckpoint:async p=>{progress=p;throw new Error('crash');}}),/crash/);
    assert.equal(progress.chunks.length,1);const firstKey=progress.chunks[0].key;
    const result=await exportArchive({storage,masterKey:key,context:c,records:projection.records(),trustedControls,chunkBytes:1024,assertLease:async()=>{},resume:progress.chunks});
    const m=await readArchiveManifest({storage,...result,masterKey:key,expected:c});assert.equal(m.chunks[0].key,firstKey);
    const wrong=structuredClone(progress.chunks);wrong[0].plainSha256='f'.repeat(64);
    await assert.rejects(()=>exportArchive({storage,masterKey:key,context:c,records:projection.records(),trustedControls,chunkBytes:1024,assertLease:async()=>{},resume:wrong}),/resume-source/);
  }finally{await projection.destroy();}
});
test('restore sink always destroyed on financial mismatch',async()=>{
  const f=await packageFixture();let destroyed=false;
  await assert.rejects(()=>verifyArchive({...f,masterKey:key,expected:f.c,trustedControls:{...f.trustedControls,signedReceivablesMinor:1},sink:{isolated:true,append:async()=>{},destroy:async()=>{destroyed=true;}}}),/controls/);assert(destroyed);
});
test('R2 adapter uses conditional immutable put, bounded download, and does not claim acceptance',async()=>{
  const objects=new Map();let conditional;
  const bucket={async put(k,bytes,options){conditional=options.onlyIf.get('If-None-Match');if(objects.has(k))return null;objects.set(k,Buffer.from(bytes));return {etag:'not-proof'};},async get(k){const bytes=objects.get(k);return bytes?{size:bytes.length,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})}:null;}};
  const storage=new R2ArchiveStorage(bucket),bytes=Buffer.from('synthetic ciphertext'),hash=createHash('sha256').update(bytes).digest('hex'),path=`archives/v1/${tenantId}/2026/run/chunks/${hash}`;
  await storage.putImmutable(path,bytes);await storage.putImmutable(path,bytes);assert.equal(conditional,'*');assert.deepEqual(await storage.read(path,{maxBytes:bytes.length}),bytes);assert.equal(storage.productionDurabilityAccepted,false);
  await assert.rejects(()=>storage.read(path,{maxBytes:1}),/limit/);
});
test('coordinator resumes bounded steps, reserves retries, verifies pointer and never prunes',async()=>{
  const changes=[change(1,'party',party('customer')),...Array.from({length:10},(_,i)=>change(i+2,'entry',{...invoice('sale_'+i),note:'x'.repeat(300)}))];
  const adapter=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:changes.length}}),store=new ArchiveStateStore(adapter,{now:()=>due});
  await store.create({tenantId,year:2026,runId:'coordinator_run'});let lease=await store.acquire(tenantId,2026,'runner');await store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true});
  const storage=new SyntheticArchiveStorage();let reservations=0,result;
  const options={stateStore:store,tenantId,year:2026,storage,masterKey:key,keyId:'synthetic_only',sourceFactory:c=>makeProjection(changes,c),budget:{reserve:async()=>{reservations++;}},maxNewChunks:2,chunkBytes:1024,now:()=>due};
  for(let i=0;i<20;i++){result=await runArchiveExportStep({...options,lease});lease=result.lease;if(result.state==='verified')break;assert.equal(result.state,'exporting');}
  assert.equal(result.state,'verified');assert(reservations>1);assert.equal(result.run.evidence.verified.manifestSha256,result.run.manifest.sha256);assert.equal(result.run.checkpoint.sequence,changes.length);
  assert.equal(adapter.roots.get(tenantId).sequence,changes.length);assert.equal(adapter.roots.get(tenantId).archivePolicy.lastVerifiedYear,2026);
});
test('coordinator budget denial performs no source/storage work',async()=>{
  const store=new ArchiveStateStore(new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:0}}),{now:()=>due});await store.create({tenantId,year:2026,runId:'budget'});const lease=await store.acquire(tenantId,2026,'runner');await store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true});let touched=false;
  await assert.rejects(()=>runArchiveExportStep({stateStore:store,tenantId,year:2026,lease,keyId:'synthetic',storage:new SyntheticArchiveStorage(),masterKey:key,sourceFactory:async()=>{touched=true;},budget:{reserve:async()=>{throw new Error('budget-disabled');}},now:()=>due}),/budget-disabled/);assert.equal(touched,false);
});
