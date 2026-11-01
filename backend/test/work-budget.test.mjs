import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveWorkBudget,SyntheticWorkBudgetAdapter} from '../src/work-budget.mjs';
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
