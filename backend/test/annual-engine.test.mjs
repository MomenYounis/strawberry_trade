import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
import {SyntheticArchiveStorage,R2ArchiveStorage,MirroredArchiveStorage} from '../src/archive-storage.mjs';
import {createPrivateAnnualEngine,annualStorageBudgetModel} from '../src/annual-engine.mjs';
import {createBoundedAnnualCatalog,createFirestoreAnnualCatalogAdapter} from '../src/annual-catalog.mjs';
import {hash} from '../src/validation.mjs';
import {readArchiveManifest} from '../src/archive-format.mjs';
import {ArchiveWorkBudget,SyntheticWorkBudgetAdapter} from '../src/work-budget.mjs';
const start=Date.parse('2027-09-03T12:00:00Z');
const enabled={schedulerEnabled:true,exportEnabled:true,closeApproved:true,openingBalancePolicy:'dated-openings',maxSourceRecordsPerStep:2,maxSourcePagesPerStep:1,maxArchiveChunkBytes:4096};
function fixture({count=9,config=enabled,storage=new SyntheticArchiveStorage(),plans=true}={}){
 let time=start;
 const roots={a:{enabled:true,sequence:count},b:{enabled:true,sequence:0}},adapter=new SyntheticArchiveStateAdapter(roots),stateStore=new ArchiveStateStore(adapter,{now:()=>time}),rows=[];
 const party={id:'customer',tenantId:'a',kind:'merchant',name:'Synthetic customer',openingMinor:5000,revision:1};
 rows.push({sequence:1,entity:'party',id:party.id,payload:party});
 for(let index=2;index<=count;index++)rows.push({sequence:index,entity:'entry',id:'sale_'+index,payload:{id:'sale_'+index,tenantId:'a',kind:'sale',date:'2027-08-31',partyId:party.id,qtyMilli:1000,priceMinor:100,totalMinor:100,paidMinor:50,unit:'kg',grade:'A',revision:1}});
 const reservations=[],calls=[];const budget={reserve:async entry=>{reservations.push(entry);calls.push('reserve');}};
 const slice=(values,after,limit)=>values.filter(value=>after===null||value.id>after).sort((a,b)=>a.id<b.id?-1:1).slice(0,limit);
 const catalogAdapter={kind:'synthetic',
  async listTenants({afterTenant,limit}){calls.push('tenants');return slice([...adapter.roots].map(([id,payload])=>({id,payload:structuredClone(payload)})),afterTenant,limit);},
  async readTenant({tenantId}){calls.push('root');return structuredClone(adapter.roots.get(tenantId));},
  async listRuns({tenantId,after,limit}){calls.push('runs');return slice([...adapter.runs.values()].filter(run=>run.tenantId===tenantId).map(payload=>({id:String(payload.year),payload:structuredClone(payload)})),after,limit);},
  async listOpeningParties({tenantId,after,limit}){calls.push('parties');return slice(tenantId==='a'?[{id:party.id,payload:structuredClone(party)}]:[],after,limit);},
 };
 const openingPlans=plans?[{policy:'dated-openings',tenantId:'a',year:2026,checkpointSequence:count,reviewedByUid:'owner_review_fixture',reviewedOn:'2027-09-03',dates:[{partyId:party.id,effectiveDate:'2026-09-01',partySha256:hash(party)}]}]:[];
 const source={readState:async({tenantId})=>structuredClone(adapter.roots.get(tenantId)),readChanges:async({tenantId,afterSequence,throughSequence,limit})=>{assert.equal(tenantId,'a');calls.push('changes');return rows.filter(row=>row.sequence>afterSequence&&row.sequence<=throughSequence).slice(0,limit);}};
 const options={stateStore,catalogAdapter,source,storage,masterKey:randomBytes(32),keyId:'synthetic_key',budget,config,openingPlans,mode:'synthetic',now:()=>time};
 return {adapter,stateStore,catalogAdapter,reservations,calls,rows,party,options,storage,engine:createPrivateAnnualEngine(options),advance:ms=>time+=ms,setTime:value=>time=value};
}
async function finish(f,engine=f.engine){let result;for(let attempt=0;attempt<30;attempt++){
 result=await engine.tick();if(result.processed.some(row=>row.status==='verified'))return result;f.advance(61_000);
 }throw Error('synthetic-engine-did-not-finish');}
test('concrete private engine is default OFF and production storage never inherits synthetic acceptance',async()=>{
 const f=fixture({config:{}});assert.equal((await f.engine.tick()).status,'BLOCKED');assert.deepEqual(f.calls,[]);assert.equal(f.adapter.runs.size,0);
 for(const storage of [new R2ArchiveStorage({get(){},put(){}}),new MirroredArchiveStorage(new SyntheticArchiveStorage(),new SyntheticArchiveStorage())]){
  const production=createPrivateAnnualEngine({...f.options,mode:'production',stateStore:{...f.stateStore,adapter:{kind:'firestore'}},catalogAdapter:{...f.catalogAdapter,kind:'firestore'},storage,config:{...enabled,productionAcceptanceApproved:true,independentRecoveryAccepted:true,keyRecoveryAccepted:true}});
  assert.equal((await production.tick()).status,'BLOCKED');assert.ok(production.blockers().includes('durable-storage-not-accepted'));
 }
 assert.equal(f.calls.length,0);
});
test('missing, changed or stale reviewed opening plans cannot checkpoint and no date is invented',async()=>{
 const f=fixture({plans:false});const missing=await f.engine.tick();assert.equal(missing.processed[0].reason,'opening-date-plan-required');assert.equal(f.adapter.runs.size,0);
 const changed=fixture();changed.party.openingMinor++;
 assert.equal((await changed.engine.tick()).processed[0].reason,'opening-date-plan-required');assert.equal(changed.adapter.runs.size,0);
 const stale=fixture();stale.adapter.roots.get('a').sequence++;
 await assert.rejects(stale.engine.tick(),/opening-date-plan-stale/);assert.equal(stale.adapter.runs.size,0);
});
test('scheduler captures bounded encrypted pages across ticks and verifies independently expected financial controls',async()=>{
 const f=fixture();const first=await f.engine.tick();assert.equal(first.processed[0].status,'preparing');assert.equal((await f.stateStore.read('a',2026)).sourcePreparation.sourceCursor,2);
 assert.equal((await f.engine.tick()).processed[0].status,'BUSY');await finish(f);
 const run=await f.stateStore.read('a',2026);assert.equal(run.state,'verified');assert.equal(run.evidence.verified.productionDurabilityAccepted,false);
 const manifest=await readArchiveManifest({storage:f.storage,manifestKey:run.manifest.key,manifestSha256:run.manifest.sha256,masterKey:f.options.masterKey,expected:{tenantId:'a',year:2026}});
 assert.equal(manifest.controls.signedReceivablesMinor,5400);assert.equal(manifest.controls.periodRecordedCashMinor,400);
 assert.equal(f.calls.filter(value=>value==='changes').length,5);
 for(let index=0;index<f.calls.length;index++)if(['tenants','runs','parties','root','changes'].includes(f.calls[index]))assert.equal(f.calls[index-1],'reserve');
 // The engine must not charge reservation I/O again: only the concrete budget
 // adapter knows whether the reservation uses Firestore or synthetic memory.
 assert.ok(f.reservations.some(entry=>entry.costs.r2ClassA===1&&entry.costs.firestoreReads===undefined&&entry.costs.firestoreWrites===undefined));
 assert.equal(f.adapter.roots.get('b').archivePolicy,undefined);
});
test('interrupted encrypted upload resumes the same checkpoint; current-year writes do not stale an already reviewed close',async()=>{
 const f=fixture({count:7});const put=f.storage.putImmutable.bind(f.storage);let failed=false;
 f.storage.putImmutable=async(...args)=>{if(!failed){failed=true;throw Error('synthetic-object-store-interruption');}return put(...args);};
 await assert.rejects(f.engine.tick(),/synthetic-object-store-interruption/);
 const checkpoint=(await f.stateStore.read('a',2026)).checkpoint;
 f.storage.putImmutable=put;f.adapter.roots.get('a').sequence=8;
 f.rows.push({sequence:8,entity:'entry',id:'current',payload:{...f.rows[1].payload,id:'current',date:'2027-09-03'}});
 f.advance(61_000);await finish(f);
 const run=await f.stateStore.read('a',2026);assert.deepEqual(run.checkpoint,checkpoint);assert.equal(run.sourcePreparation.sourceCursor,7);
 const manifest=await readArchiveManifest({storage:f.storage,manifestKey:run.manifest.key,manifestSha256:run.manifest.sha256,masterKey:f.options.masterKey,expected:{tenantId:'a',year:2026}});
 assert.equal(manifest.controls.signedReceivablesMinor,5300);
});
test('shared budget refusal happens before any catalog query or close, and overlapping ticks are single-flight',async()=>{
 const f=fixture(),denied=createPrivateAnnualEngine({...f.options,budget:{reserve:async()=>{throw Error('shared-budget-exhausted');}}});
 await assert.rejects(denied.tick(),/shared-budget-exhausted/);assert.deepEqual(f.calls,[]);assert.equal(f.adapter.runs.size,0);
 let release;const wait=new Promise(done=>{release=done;});const original=f.catalogAdapter.listTenants;
 f.catalogAdapter.listTenants=async args=>{await wait;return original(args);};
 const first=f.engine.tick();await Promise.resolve();assert.equal((await f.engine.tick()).status,'BUSY');release();await first;
});
test('engine with an overhead-accounting budget charges the first catalog reservation only once',async()=>{
 const f=fixture(),adapter=new SyntheticWorkBudgetAdapter();
 // A provider adapter declares its own reservation work. Synthetic state here
 // isolates the integration without using real provider credentials or I/O.
 adapter.reservationCosts=Object.freeze({firestoreReads:5,firestoreWrites:5});
 const actual=new ArchiveWorkBudget(adapter,{enabled:true,limits:{firestoreReads:7,firestoreWrites:5},headroom:async()=>true,now:f.options.now});
 const engine=createPrivateAnnualEngine({...f.options,budget:actual});
 // The first catalog page costs two reads plus the five-read/five-write
 // reservation. The next step must then stop before a second catalog query.
 await assert.rejects(engine.tick(),/archive-budget-exhausted-firestoreReads/);
 assert.equal(adapter.state.usage.firestoreReads.reserved,7);assert.equal(adapter.state.usage.firestoreWrites.reserved,5);
 assert.deepEqual(f.calls,['tenants']);assert.equal(f.adapter.runs.size,0);
});
test('catalog checks exact root identity after paginated parties and enforces record/byte limits',async()=>{
 const f=fixture(),original=f.catalogAdapter.listOpeningParties;
 f.catalogAdapter.listOpeningParties=async args=>{const rows=await original(args);f.adapter.roots.get('a').sequence++;return rows;};
 const catalog=createBoundedAnnualCatalog({adapter:f.catalogAdapter,budget:f.options.budget,openingPlans:f.options.openingPlans,now:f.options.now,pageSize:1});
 await assert.rejects(catalog.page({limit:1}),/snapshot-changed/);
 const large=fixture();large.catalogAdapter.listOpeningParties=async({after,limit})=>Array.from({length:3},(_,index)=>({id:'p_'+index,payload:{...large.party,id:'p_'+index}})).filter(row=>after===null||row.id>after).slice(0,limit);
 await assert.rejects(createBoundedAnnualCatalog({adapter:large.catalogAdapter,budget:large.options.budget,openingPlans:large.options.openingPlans,now:large.options.now,pageSize:1,maxParties:2}).page({limit:1}),/record-limit/);
 const bytes=fixture();bytes.catalogAdapter.listOpeningParties=async()=>[{id:'customer',payload:{...bytes.party,name:'x'.repeat(2000)}}];
 await assert.rejects(createBoundedAnnualCatalog({adapter:bytes.catalogAdapter,budget:bytes.options.budget,now:bytes.options.now,maxBytes:1024}).page({limit:1}),/byte-limit/);
});
test('Firestore catalog adapter uses scoped stable-ID queries only',async()=>{
 const calls=[];const query=path=>({orderBy(field){calls.push([path,'order',field.toString()]);return this;},startAfter(value){calls.push([path,'after',value]);return this;},limit(value){calls.push([path,'limit',value]);return this;},async get(){return {docs:[]};}});
 const db={collection:path=>query(path),doc:path=>({collection:name=>query(path+'/'+name),get:async()=>({data:()=>({enabled:true,sequence:1})})})},adapter=createFirestoreAnnualCatalogAdapter(db);
 await adapter.listTenants({afterTenant:'a',limit:2});await adapter.listOpeningParties({tenantId:'tenant_a',after:'party_a',limit:10});await adapter.listRuns({tenantId:'tenant_a',limit:5});
 assert.ok(calls.every(([path])=>['tenants','tenants/tenant_a/parties','tenants/tenant_a/archiveRuns'].includes(path)));
 assert.equal(calls.filter(([,op])=>op==='order').length,3);assert.ok(calls.some(([,op,value])=>op==='after'&&value==='party_a'));
});
test('next close keeps cross-year references and a prospective salary term without posting held historical salary evidence',async()=>{
 const f=fixture({count:3});
 f.rows.push({sequence:4,entity:'employee',id:'staff',payload:{id:'staff',tenantId:'a',name:'Synthetic staff',active:true,revision:1}});
 f.adapter.roots.get('a').sequence=4;
 const firstPlan={...f.options.openingPlans[0],checkpointSequence:4};
 await finish(f,createPrivateAnnualEngine({...f.options,openingPlans:[firstPlan]}));
 const first=await f.stateStore.read('a',2026),firstBytes=await f.storage.read(first.manifest.key,{maxBytes:262144});
 const oldManifest=await readArchiveManifest({storage:f.storage,manifestKey:first.manifest.key,manifestSha256:first.manifest.sha256,masterKey:f.options.masterKey,expected:{tenantId:'a',year:2026}});
 assert.deepEqual(oldManifest.controls.payrollObligations,[]);assert.equal(oldManifest.controls.signedReceivablesMinor,5100);
 // Cleanup remains independent of financial verification and does not block
 // the next yearly close. No deletion capability exists in this engine.
 await f.stateStore.advance('a',2026,first.lease,'verified','cleanup_pending');
 const held={id:'held_august_rate',status:'needs_review',operation:{entity:'salary_term',payload:{employeeId:'staff',effectiveMonth:'2027-08',monthlyMinor:100000}}},heldBefore=structuredClone(held);
 // These are accepted-feed fixtures. The gateway's separately tested manager
 // resolution authorizes the unchanged rate prospectively, never August debt.
 f.rows.push({sequence:5,entity:'salary_term',id:'prospective_rate',payload:{id:'prospective_rate',tenantId:'a',employeeId:'staff',effectiveMonth:'2027-09',monthlyMinor:100000,revision:1}},
  {sequence:6,entity:'entry',id:'september_pay',payload:{id:'september_pay',tenantId:'a',kind:'payroll',date:'2027-09-15',employeeId:'staff',salaryMonth:'2027-09',totalMinor:5000,paidMinor:5000,revision:1}},
  {sequence:7,entity:'entry',id:'prior_invoice_return',payload:{...f.rows[1].payload,id:'prior_invoice_return',kind:'sale_return',originalId:'sale_2',date:'2027-09-15',qtyMilli:500,totalMinor:50,paidMinor:0}});
 f.adapter.roots.get('a').sequence=7;f.setTime(Date.parse('2028-09-03T12:00:00Z'));
 const nextPlan={...firstPlan,year:2027,checkpointSequence:7,reviewedOn:'2028-09-03'};
 await finish(f,createPrivateAnnualEngine({...f.options,openingPlans:[nextPlan]}));
 const second=await f.stateStore.read('a',2027),manifest=await readArchiveManifest({storage:f.storage,manifestKey:second.manifest.key,manifestSha256:second.manifest.sha256,masterKey:f.options.masterKey,expected:{tenantId:'a',year:2027}});
 assert.equal(manifest.context.previousCloseHash,first.manifest.sha256);assert.equal(manifest.controls.signedReceivablesMinor,5050);
 assert.equal(manifest.controls.counts.reference,1);assert.equal(manifest.controls.payrollObligations.length,12);
 assert.equal(manifest.controls.payrollObligations[0].salaryMonth,'2027-09');assert.equal(manifest.controls.payrollObligations[0].balanceMinor,95000);
 assert.equal(manifest.controls.payrollObligations.reduce((sum,row)=>sum+row.balanceMinor,0),1195000);
 assert.deepEqual(held,heldBefore);assert.deepEqual(await f.storage.read(first.manifest.key,{maxBytes:262144}),firstBytes);
 assert.equal((await f.stateStore.read('a',2026)).state,'cleanup_pending');
});
test('tick deadline defers after a slow reservation before any catalog or financial I/O',async()=>{
 const f=fixture(),engine=createPrivateAnnualEngine({...f.options,config:{...enabled,maxTickRuntimeMs:1000},budget:{reserve:async()=>{f.advance(1001);}}});
 assert.deepEqual(await engine.tick(),{status:'DEFERRED',reason:'tick-runtime',nextTenant:null,processed:[]});assert.deepEqual(f.calls,[]);assert.equal(f.adapter.runs.size,0);
});
test('storage budget covers immutable collision reads and both mirrored readbacks; cyclic/unknown graphs fail closed',async()=>{
 const first=new SyntheticArchiveStorage(),second=new SyntheticArchiveStorage(),mirror=new MirroredArchiveStorage(first,second);
 assert.deepEqual(annualStorageBudgetModel(first),{writeA:1,writeB:1,readB:1});
 assert.deepEqual(annualStorageBudgetModel(mirror),{writeA:2,writeB:4,readB:1});
 assert.throws(()=>annualStorageBudgetModel({kind:'mirrored',primary:first,recovery:first}),/storage-model/);
 const cycle={kind:'mirrored',recovery:first};cycle.primary=cycle;assert.throws(()=>annualStorageBudgetModel(cycle),/storage-model/);
 assert.throws(()=>annualStorageBudgetModel({kind:'unreviewed-cloud-storage'}),/storage-model/);
 const f=fixture({count:3});await finish(f);
 const upload=f.reservations.find(entry=>entry.costs.r2ClassA===1);assert.ok(upload.costs.r2ClassB>=1);assert.ok(upload.costs.downloadBytes>=524288);
});
test('disabled or deleting tenants are skipped without scanning financial collections or creating a close',async()=>{
 for(const change of [{enabled:false},{adminDeleting:true}]){
  const f=fixture();Object.assign(f.adapter.roots.get('a'),change);
  const result=await f.engine.tick();assert.deepEqual(result.processed,[]);
  assert.equal(f.adapter.runs.size,0);assert.equal(f.storage.objects.size,0);
  assert.equal(f.calls.includes('runs'),false);assert.equal(f.calls.includes('parties'),false);assert.equal(f.calls.includes('changes'),false);
 }
});
test('deactivation between catalog selection and lease acquisition fences close before policy publication',async()=>{
 for(const change of [{enabled:false},{adminDeleting:true}]){
  const f=fixture(),read=f.stateStore.read.bind(f.stateStore);
  f.stateStore.read=async(...args)=>{const result=await read(...args);Object.assign(f.adapter.roots.get('a'),change);return result;};
  await assert.rejects(f.engine.tick(),/tenant-not-active/);
  assert.equal(f.adapter.roots.get('a').archivePolicy,undefined);assert.equal(f.adapter.runs.size,0);assert.equal(f.storage.objects.size,0);
 }
});
