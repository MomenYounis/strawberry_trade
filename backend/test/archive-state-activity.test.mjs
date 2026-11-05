import test from 'node:test';import assert from 'node:assert/strict';import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
const now=()=>Date.parse('2027-09-02T00:00:00Z');
test('deactivation and deletion fence every archive mutation and lease; no close or pointer after revocation',async()=>{
 for(const rootChange of [{adminDeleting:true},{enabled:false}]){
  const adapter=new SyntheticArchiveStateAdapter({tenant:{enabled:true,sequence:2}}),store=new ArchiveStateStore(adapter,{now});
  await store.create({tenantId:'tenant',year:2026,runId:'run'});const lease=await store.acquire('tenant',2026,'worker');await store.checkpoint('tenant',2026,lease,{authorizedClose:true,exportEnabled:true});
  Object.assign(adapter.roots.get('tenant'),rootChange);const before=await store.read('tenant',2026);
  for(const operation of [()=>store.assertCurrent('tenant',2026,lease),()=>store.renew('tenant',2026,lease),()=>store.acquire('tenant',2026,'new'),()=>store.advance('tenant',2026,lease,'checkpointed','exporting'),()=>store.recordRetry('tenant',2026,lease,{code:'retry',retryAfterMs:now()})])await assert.rejects(operation,/tenant-not-active/);
  assert.deepEqual(await store.read('tenant',2026),before);
 }
});
