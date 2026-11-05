import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveWorkBudget,SyntheticWorkBudgetAdapter,FirestoreWorkBudgetAdapter} from '../src/work-budget.mjs';
import {captureActiveSnapshotScope,immutableActiveChangesAtCheckpoint,createActiveSnapshotProjection} from '../src/active-snapshot-projection.mjs';
import {createActiveSnapshotPackage} from '../src/active-snapshot-service.mjs';
import {immutableFeedDocumentsForPlan,createFeedPrunePlan} from '../src/feed-pruner.mjs';
const costs={firestoreReads:60,r2ClassA:1};
const request=(tenantId='synthetic_a')=>({tenantId,stepId:'step_1',costs});
test('two concurrent tenants share one cap; failed reservation changes no counters',async()=>{
  const adapter=new SyntheticWorkBudgetAdapter();
  const budget=new ArchiveWorkBudget(adapter,{limits:{firestoreReads:100,r2ClassA:100},enabled:true,headroom:async()=>true});
  const results=await Promise.allSettled([budget.reserve(request()),budget.reserve(request('synthetic_b'))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(adapter.state.usage.firestoreReads.reserved,60);assert.equal(adapter.state.usage.r2ClassA.reserved,1);
});
test('disabled/missing live headroom and zero-delete cap refuse before work',async()=>{
  const adapter=new SyntheticWorkBudgetAdapter();
  await assert.rejects(new ArchiveWorkBudget(adapter).reserve(request()),/disabled/);
  await assert.rejects(new ArchiveWorkBudget(adapter,{enabled:true,limits:{firestoreReads:100,r2ClassA:2}}).reserve(request()),/headroom-unverified/);
  const budget=new ArchiveWorkBudget(adapter,{enabled:true,limits:{firestoreDeletes:0},headroom:async()=>true});
  await assert.rejects(budget.reserve({...request(),costs:{firestoreDeletes:1}}),/exhausted/);
  assert.deepEqual(adapter.state,{});
});
test('repeated operation attempt charges again despite matching diagnostic step ID',async()=>{
  const adapter=new SyntheticWorkBudgetAdapter(),budget=new ArchiveWorkBudget(adapter,{enabled:true,limits:{r2ClassA:2},headroom:async()=>true});
  const r={...request(),costs:{r2ClassA:1}};await budget.reserve(r);await budget.reserve(r);
  await assert.rejects(budget.reserve(r),/exhausted/);assert.equal(adapter.state.usage.r2ClassA.reserved,2);
});
test('UTC and Pacific internal windows reset at different civil midnight including DST',async()=>{
  let now=Date.parse('2027-07-01T23:59:59Z');const adapter=new SyntheticWorkBudgetAdapter();
  const budget=new ArchiveWorkBudget(adapter,{enabled:true,limits:{firestoreReads:100,workerRequests:10},headroom:async()=>true,now:()=>now});
  const r={...request(),costs:{firestoreReads:40,workerRequests:6}};
  await budget.reserve(r);now=Date.parse('2027-07-02T00:00:00Z');await budget.reserve(r);
  assert.equal(adapter.state.usage.firestoreReads.reserved,80);assert.equal(adapter.state.usage.workerRequests.reserved,6);
  now=Date.parse('2027-07-02T07:00:00Z');await budget.reserve({...r,costs:{firestoreReads:40,workerRequests:4}});
  assert.equal(adapter.state.usage.firestoreReads.reserved,40);
});
test('unknown resources and unsafe costs fail closed',async()=>{
  const adapter=new SyntheticWorkBudgetAdapter();
  assert.throws(()=>new ArchiveWorkBudget(adapter,{limits:{bogus:3}}),/unknown/);
  const budget=new ArchiveWorkBudget(adapter,{enabled:true,limits:{firestoreReads:100},headroom:async()=>true});
  for(const costs of [{r2ClassA:1},{firestoreReads:NaN},{firestoreReads:1.1},{firestoreReads:-1},{firestoreReads:Number.MAX_SAFE_INTEGER+1}])await assert.rejects(budget.reserve({...request(),costs}));
  assert.deepEqual(adapter.state,{});
});

// The transaction double deliberately reruns callbacks, discarding all but the
// final draft. It counts every attempted read/write independently of the budget.
function firestoreBudget({attempts=1}={}){
  let state={},queue=Promise.resolve();const calls={transactions:0,reads:0,writes:0,options:[]};
  const db={doc:path=>({path,firestore:db}),runTransaction(fn,options){
    calls.transactions++;calls.options.push(options);
    const result=queue.then(async()=>{
      let answer;
      for(let attempt=0;attempt<attempts;attempt++){
        let next=structuredClone(state);
        answer=await fn({get:async()=>{calls.reads++;return {exists:Object.keys(state).length>0,data:()=>structuredClone(state)};},set:(_ref,value)=>{calls.writes++;next=structuredClone(value);}});
        if(attempt===attempts-1)state=next;
      }
      return answer;
    });queue=result.catch(()=>{});return result;
  }};
  return {adapter:new FirestoreWorkBudgetAdapter(db),calls,get state(){return structuredClone(state);}};
}
const firestoreLimits={firestoreReads:1000,firestoreWrites:1000,r2ClassA:100};
const monitored=(adapter,limits=firestoreLimits)=>new ArchiveWorkBudget(adapter,{enabled:true,limits,headroom:async()=>true});
test('R2-only request refuses zero or missing Firestore overhead allowances before any I/O',async()=>{
  for(const limits of [{r2ClassA:1,firestoreReads:10,firestoreWrites:0},{r2ClassA:1,firestoreWrites:10,firestoreReads:0},{r2ClassA:1}]){
    const f=firestoreBudget();let monitorCalls=0;
    const budget=new ArchiveWorkBudget(f.adapter,{enabled:true,limits,headroom:async()=>{monitorCalls++;return true;}});
    await assert.rejects(budget.reserve({...request(),costs:{r2ClassA:1}}),/archive-budget-exhausted-firestore|unbudgeted-resource/);
    assert.deepEqual(f.calls,{transactions:0,reads:0,writes:0,options:[]});assert.equal(monitorCalls,0);
  }
});
test('Firestore reservation centrally charges its bounded five retry attempts exactly once',async()=>{
  const f=firestoreBudget({attempts:5}),budget=monitored(f.adapter),costs={r2ClassA:1,firestoreReads:2};
  const receipt=await budget.reserve({...request(),costs});
  assert.deepEqual(costs,{r2ClassA:1,firestoreReads:2});
  assert.deepEqual(receipt.costs,{r2ClassA:1,firestoreReads:7,firestoreWrites:5});
  assert.equal(f.state.usage.firestoreReads.reserved,7);assert.equal(f.state.usage.firestoreWrites.reserved,5);
  assert.equal(f.calls.reads,5);assert.equal(f.calls.writes,5);assert.deepEqual(f.calls.options,[{maxAttempts:5}]);
});
test('two tenants share the same Firestore overhead allowance, including R2-only work',async()=>{
  const f=firestoreBudget(),budget=monitored(f.adapter,{firestoreReads:10,firestoreWrites:5,r2ClassA:2});
  const results=await Promise.allSettled(['synthetic_a','synthetic_b'].map(tenantId=>budget.reserve({tenantId,stepId:'upload',costs:{r2ClassA:1}})));
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  assert.match(results.find(row=>row.status==='rejected').reason.message,/archive-budget-exhausted-firestoreWrites/);
  assert.equal(f.state.usage.r2ClassA.reserved,1);assert.equal(f.state.usage.firestoreWrites.reserved,5);
});
test('standalone active-snapshot and feed-prune source callers charge the same central overhead',async()=>{
  const f=firestoreBudget(),budget=monitored(f.adapter);let sourceCalls=0;
  const row={sequence:1},query={where(){return this;},orderBy(){return this;},limit(){return this;},get:async()=>{sourceCalls++;return {docs:[{id:'0000000000000001',data:()=>row,updateTime:{seconds:1,nanoseconds:0}}]};}};
  const db={doc:()=>({collection:()=>query})};
  for await(const value of immutableActiveChangesAtCheckpoint(db,{tenantId:'synthetic_a',checkpointSequence:1,pageSize:1,budget}))assert.equal(value.sequence,1);
  for await(const value of immutableFeedDocumentsForPlan(db,{tenantId:'synthetic_b',fromSequence:0,checkpointSequence:1,pageSize:1,budget}))assert.equal(value.data.sequence,1);
  assert.equal(sourceCalls,2);assert.equal(f.state.usage.firestoreReads.reserved,13);assert.equal(f.state.usage.firestoreWrites.reserved,10);
});
test('standalone snapshot authority capture refuses an unbudgeted reservation write before provider reads',async()=>{
  const f=firestoreBudget(),budget=monitored(f.adapter,{firestoreReads:100,firestoreWrites:0});let sourceCalls=0;
  const db={doc:()=>({}),runTransaction:async()=>{sourceCalls++;throw Error('provider-must-not-run');}};
  await assert.rejects(captureActiveSnapshotScope({db,snapshotId:'snapshot_1',tenantId:'synthetic_a',uid:'manager_a',role:'manager',membershipEpoch:1,budget}),/archive-budget-exhausted-firestoreWrites/);
  assert.equal(sourceCalls,0);assert.equal(f.calls.transactions,0);
});
test('adding reservation overhead rejects integer overflow before any transaction',async()=>{
  const f=firestoreBudget(),budget=monitored(f.adapter,{firestoreReads:Number.MAX_SAFE_INTEGER,firestoreWrites:10});
  await assert.rejects(budget.reserve({...request(),costs:{firestoreReads:Number.MAX_SAFE_INTEGER}}),/archive-budget-overflow/);
  assert.equal(f.calls.transactions,0);
});
test('snapshot uploads and feed-prune plan uploads both refuse zero Firestore writes before storage I/O',async t=>{
  const tenantId='synthetic_a',scope={snapshotId:'snapshot_1',tenantId,uid:'manager_a',role:'manager',membershipEpoch:1,checkpointSequence:1,historyFloor:0};
  const row={sequence:1,entity:'party',id:'customer_a',payload:{id:'customer_a',tenantId,kind:'merchant',name:'Synthetic customer',openingMinor:0,revision:1}};
  const projection=await createActiveSnapshotProjection({scope});t.after(()=>projection.destroy());await projection.ingest([row]);
  const f=firestoreBudget(),budget=monitored(f.adapter,{r2ClassA:100,firestoreReads:100,firestoreWrites:0});let uploads=0;
  const upload=async()=>{uploads++;throw Error('storage-must-not-run');};
  await assert.rejects(createActiveSnapshotPackage({projection,budget,writePage:upload}),/archive-budget-exhausted-firestoreWrites/);
  await assert.rejects(createFeedPrunePlan({projection,tenantId,year:2026,runId:'run_1',snapshotHeaderSha256:'a'.repeat(64),source:[{id:'0000000000000001',data:row,updateTime:{seconds:1,nanoseconds:0}}],budget,writePage:upload}),/archive-budget-exhausted-firestoreWrites/);
  assert.equal(uploads,0);assert.equal(f.calls.transactions,0);
});
