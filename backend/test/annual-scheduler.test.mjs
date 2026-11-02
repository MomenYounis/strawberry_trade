import test from 'node:test';import assert from 'node:assert/strict';
import {createAnnualScheduler} from '../src/annual-scheduler.mjs';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
const now=()=>Date.UTC(2027,8,3,12);
function fixture(config={}){
 const adapter=new SyntheticArchiveStateAdapter({a:{enabled:true,sequence:10},b:{enabled:true,sequence:20}});
 const stateStore=new ArchiveStateStore(adapter,{now});const calls=[];
 const scheduler=createAnnualScheduler({stateStore,now,mode:'synthetic',storage:{kind:'synthetic'},config,
  catalog:{page:async({afterTenant,limit})=>({tenants:['a','b'].filter(x=>!afterTenant||x>afterTenant).slice(0,limit).map(tenantId=>({tenantId,enabled:true,undatedOpeningCount:0,openingParties:[],openingDatePlan:{policy:'dated-openings',tenantId,year:2026,checkpointSequence:tenantId==='a'?10:20,reviewedByUid:'owner',reviewedOn:'2027-09-03',dates:[]}})),hasMore:!afterTenant&&limit===1})},
  executeStep:async options=>{calls.push(options);return {state:'exporting'};}});
 return {scheduler,calls,stateStore,adapter};
}
test('default scheduler cannot close, reserve work or enumerate production tenants',async()=>{
 const f=fixture();assert.equal((await f.scheduler.tick()).status,'BLOCKED');assert.equal(f.calls.length,0);assert.equal(f.adapter.runs.size,0);
});
test('bounded synthetic ticks checkpoint each tenant once and concurrent retries respect leases',async()=>{
 const f=fixture({schedulerEnabled:true,exportEnabled:true,closeApproved:true,openingBalancePolicy:'dated-openings'});
 const first=await f.scheduler.tick({maxTenants:1});assert.equal(first.nextTenant,'a');
 assert.equal((await f.stateStore.read('a',2026)).checkpoint.sequence,10);
 assert.equal((await f.scheduler.tick({maxTenants:1})).processed[0].status,'BUSY');
 await f.scheduler.tick({afterTenant:first.nextTenant,maxTenants:1});
 assert.deepEqual(f.calls.map(x=>x.tenantId),['a','b']);assert.ok(f.calls.every(x=>x.maxNewChunks===1));
});
test('synthetic storage never supplies production or independent-recovery acceptance',async()=>{
 const f=fixture();const production=createAnnualScheduler({stateStore:f.stateStore,catalog:{page:async()=>{throw Error('must not enumerate');}},executeStep:async()=>{},storage:{kind:'synthetic'},config:{schedulerEnabled:true,exportEnabled:true,closeApproved:true,openingBalancePolicy:'dated-openings'}});
 assert.equal((await production.tick()).status,'BLOCKED');assert.ok(production.blockers().includes('durable-storage-not-accepted'));
 assert.throws(()=>createAnnualScheduler({stateStore:{adapter:{kind:'firestore'}},catalog:{page(){}},executeStep(){},storage:{kind:'synthetic'},mode:'synthetic'}),/synthetic-scheduler/);
});
