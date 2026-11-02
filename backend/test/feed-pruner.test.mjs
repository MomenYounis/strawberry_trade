import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../src/validation.mjs';
import {snapshotHash} from '../src/active-snapshot-format.mjs';
import {createActiveSnapshotProjection} from '../src/active-snapshot-projection.mjs';
import {createFeedPrunePlan,verifyFeedPrunePlan,runFeedPruneStep,FirestoreFeedPruneAdapter,immutableFeedDocumentsForPlan} from '../src/feed-pruner.mjs';

// Explicit hypothetical eligible date; no current-date/production operation.
const now=Date.parse('2027-12-01T00:00:00Z'),C=45,year=2026,tenantId='tenant',runId='annual_2026';
const id=sequence=>String(sequence).padStart(16,'0');
const clone=value=>structuredClone(value);
const sale=key=>({id:key,tenantId,kind:'sale',partyId:'party',partyName:'عميل',qtyMilli:1000,priceMinor:501,totalMinor:501,paidMinor:0,unit:'kg',grade:'A',date:'2026-09-01',note:'',creatorUid:'manager',revision:1});
function sourceRows(){
 const rows=[{entity:'party',id:'party',payload:{id:'party',tenantId,name:'عميل',kind:'merchant',phone:'',openingMinor:0,revision:1}}];
 for(let sequence=2;sequence<=C+2;sequence++)rows.push({entity:'entry',id:`sale_${sequence}`,payload:sale(`sale_${sequence}`)});
 return rows.map((row,index)=>({id:id(index+1),data:{...row,sequence:index+1,acceptedAtMs:now-1_000_000+index,closeVersion:1},updateTime:{seconds:1_799_000_000+index,nanoseconds:index}}));
}

// This adapter is deliberately synthetic and serialized. Exceptions, failed
// commits and gate changes roll back root, cursor and the entire queued batch.
// It cannot masquerade as the production Firestore adapter in these tests.
class SyntheticPruneAdapter{
 constructor(state){this.kind='synthetic';this.state=clone(state);this.queue=Promise.resolve();this.committedDeletes=[];this.maxBatch=0;this.transactions=0;this.failedCommits=0;this.failNextDeletingCommit=false;this.beforeTransaction=null;}
 transaction(tenant,archiveYear,fn){
  assert.equal(tenant,tenantId);assert.equal(archiveYear,year);
  const task=this.queue.then(async()=>{
   this.transactions++;if(this.beforeTransaction)await this.beforeTransaction(this);
   const state=clone(this.state),deletes=[];
   const tx={root:state.root,run:state.run,getFeedDocuments:async ids=>{
    assert.ok(ids.length<=20);return ids.map(key=>clone(state.feed.get(key)??null));
   },deleteFeedDocument:key=>{assert.ok(state.feed.has(key));deletes.push(key);assert.ok(deletes.length<=20);}};
   const result=await fn(tx);this.maxBatch=Math.max(this.maxBatch,deletes.length);
   if(deletes.length&&this.failNextDeletingCommit){this.failNextDeletingCommit=false;this.failedCommits++;throw new Error('synthetic commit failure');}
   for(const key of deletes){state.feed.delete(key);this.committedDeletes.push(key);}
   this.state=state;return result;
  });
  this.queue=task.catch(()=>{});return task;
 }
 mutate(fn){const task=this.queue.then(()=>{const next=clone(this.state);fn(next);this.state=next;});this.queue=task.catch(()=>{});return task;}
}

async function fixture(t){
 const rows=sourceRows(),projection=await createActiveSnapshotProjection({scope:{snapshotId:'manager_source',tenantId,uid:'manager',role:'manager',membershipEpoch:1,checkpointSequence:C,historyFloor:0}});
 t.after(()=>projection.destroy());await projection.ingest(rows.slice(0,C).map(row=>row.data));
 const objects=new Map(),reservations=[],budget={reserve:async request=>reservations.push(clone(request))};
 const snapshotHeaderSha256=snapshotHash('independently verified synthetic manager snapshot');
 const saved=await createFeedPrunePlan({projection,tenantId,year,runId,snapshotHeaderSha256,source:rows.slice(0,C),writePage:async({index,bytes})=>{const key=`private-plan/${index}`;assert.ok(!objects.has(key));objects.set(key,Buffer.from(bytes));return key;},budget});
 let readHook=null;
 const readPage=async(key,{maxBytes})=>{assert.equal(maxBytes,12_000);if(readHook)await readHook();return objects.get(key);};
 const plan=await verifyFeedPrunePlan({manifest:saved.manifest,expectedSha256:saved.sha256,readPage,budget});
 const archiveSha256=snapshotHash('independent annual manifest');
 const lease={owner:'operator_worker',fence:2,expiresAtMs:now+60_000};
 const state={root:{enabled:true,sequence:C+2,historyFloor:0,minimumSyncProtocol:1,archivePolicy:{pendingFeedConsumers:[]}},
  run:{tenantId,year,runId,state:'cleanup_pending',checkpoint:{sequence:C,version:1},lease:clone(lease),manifest:{sha256:archiveSha256},
   evidence:{verified:{financialMatch:true,identitiesMatch:true,manifestSha256:archiveSha256,closingSequence:C,closingVersion:1,verifiedAtMs:now-91*86_400_000},
    activeSnapshot:{headerSha256:snapshotHeaderSha256,checkpointSequence:C,fromSequence:0,sourceDocumentHashesSha256:projection.sourceDocumentHashesSha256,verified:true},
    cleanupAcceptance:{planSha256:saved.sha256,snapshotHeaderSha256,manifestSha256:archiveSha256,closingSequence:C,closingVersion:1,synthetic:true,independentRecovery:true,keyRecoveryTested:true,retentionChecked:true,dependenciesResolved:true,protocolAcceptance:true,clientInstallAcceptance:true}}},
  feed:new Map(rows.map(row=>[row.id,clone(row)])),employeeChanges:clone(rows),entries:rows.filter(row=>row.data.entity==='entry').map(row=>clone(row.data.payload)),operations:rows.map(row=>({id:`operation_${row.data.sequence}`,status:'accepted'})),locks:[{id:'return_lock',qtyMilli:50}],lateOperations:[{id:'held',status:'needs_review'}]};
 const storage={kind:'synthetic',productionDurabilityAccepted:false},config={cleanupEnabled:true,graceDays:90};
 const args={tenantId,year,lease,plan,budget,storage,config,mode:'synthetic',now:()=>now};
 return {rows,projection,objects,reservations,budget,saved,readPage,plan,state,args,setReadHook:hook=>{readHook=hook;}};
}
const step=(f,adapter,overrides={})=>runFeedPruneStep({...f.args,adapter,...overrides});

test('manager feed pruning is bounded, publishes floor atomically and retains every financial fact and receipt',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state),retained=clone(f.state);
 const first=await step(f,adapter);assert.equal(first.state,'pruning');assert.equal(first.deleted,20);
 assert.equal(adapter.state.root.historyFloor,C);assert.equal(adapter.state.root.minimumSyncProtocol,2);assert.equal(adapter.state.feed.size,C+2-20);
 assert.equal(adapter.state.run.pruneProgress.page,1);assert.equal(adapter.state.run.pruneProgress.planSha256,f.saved.sha256);
 const second=await step(f,adapter);assert.equal(second.deleted,40);const final=await step(f,adapter);assert.equal(final.state,'complete');assert.equal(final.deleted,C);
 assert.equal(adapter.maxBatch,20);assert.equal(adapter.committedDeletes.length,C);assert.equal(new Set(adapter.committedDeletes).size,C);
 assert.deepEqual([...adapter.state.feed.keys()],[id(C+1),id(C+2)]);
 for(const key of ['employeeChanges','entries','operations','locks','lateOperations'])assert.deepEqual(adapter.state[key],retained[key]);
 const repeated=await step(f,adapter);assert.equal(repeated.state,'complete');assert.equal(adapter.committedDeletes.length,C);
 for(const bytes of f.objects.values()){
  const page=JSON.parse(bytes.toString());assert.ok(page.records.length<=20);
  for(const row of page.records)assert.deepEqual(Object.keys(row).sort(),['bodySha256','id','sequence','updateTime']);
  assert.equal(bytes.includes(Buffer.from('عميل')),false);assert.equal(bytes.includes(Buffer.from('priceMinor')),false);
 }
});

test('failed deleting commit rolls back its full batch and resumes from the durable cursor with a new runner',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state);await step(f,adapter);
 const checkpoint=clone(adapter.state);adapter.failNextDeletingCommit=true;
 await assert.rejects(()=>step(f,adapter),/synthetic commit failure/);assert.deepEqual(adapter.state,checkpoint);assert.equal(adapter.committedDeletes.length,20);
 const restarted=new SyntheticPruneAdapter(adapter.state);await step(f,restarted);await step(f,restarted);
 assert.equal(restarted.state.run.state,'complete');assert.equal(restarted.state.run.pruneProgress.deleted,C);
 assert.deepEqual([...adapter.committedDeletes,...restarted.committedDeletes],Array.from({length:C},(_,index)=>id(index+1)));
});

test('changed provider version, changed body and unexpectedly missing candidate abort before any batch deletion',async t=>{
 const f=await fixture(t);
 for(const mutation of [
  state=>{state.feed.get(id(10)).updateTime.nanoseconds++;},
  state=>{state.feed.get(id(10)).data.payload.totalMinor++;},
  state=>{state.feed.delete(id(10));},
 ]){
  const adapter=new SyntheticPruneAdapter(f.state);await adapter.mutate(mutation);const before=clone(adapter.state);
  await assert.rejects(()=>step(f,adapter),/prune-document-(changed|missing)/);assert.deepEqual(adapter.state,before);assert.equal(adapter.committedDeletes.length,0);
 }
});

test('plan capture is bound to exact raw source used by sealed manager snapshot and rejects gaps or rewritten metadata',async t=>{
 const f=await fixture(t);let writes=0;
 const request={projection:f.projection,tenantId,year,runId,snapshotHeaderSha256:f.saved.manifest.snapshotHeaderSha256,budget:f.budget,writePage:async()=>{writes++;return `orphan-unpublished/${writes}`;}};
 const altered=clone(f.rows.slice(0,C));altered[5].data.acceptedAtMs++;
 await assert.rejects(()=>createFeedPrunePlan({...request,source:altered}),/prune-source-identity-mismatch/);
 await assert.rejects(()=>createFeedPrunePlan({...request,source:f.rows.slice(1,C)}),/prune-source-gap/);
 await assert.rejects(()=>createFeedPrunePlan({...request,source:f.rows.slice(0,C-1)}),/prune-source-identity-mismatch/);
 const wrongId=clone(f.rows.slice(0,C));wrongId[4].id='wrong';await assert.rejects(()=>createFeedPrunePlan({...request,source:wrongId}),/prune-source-gap/);
 const invalidVersion=clone(f.rows.slice(0,C));invalidVersion[0].updateTime.nanoseconds=1_000_000_000;
 await assert.rejects(()=>createFeedPrunePlan({...request,source:invalidVersion}));
 assert.equal(f.saved.manifest.sourceDocumentHashesSha256,f.projection.sourceDocumentHashesSha256);
 await assert.rejects(()=>createFeedPrunePlan({...request,projection:{...f.projection},source:f.rows.slice(0,C)}),/trusted-prune-source-required/);
});

test('plan verifier rejects wrong expected hash, altered page and a forged digest with noncontiguous rows',async t=>{
 const f=await fixture(t);
 await assert.rejects(()=>verifyFeedPrunePlan({manifest:f.saved.manifest,expectedSha256:'a'.repeat(64),readPage:f.readPage,budget:f.budget}),/invalid-prune-plan/);
 const key=f.saved.manifest.pages[0].key,original=f.objects.get(key);f.objects.set(key,Buffer.from(original.toString().replace('bodySha256','bodySHA256')));
 await assert.rejects(()=>verifyFeedPrunePlan({manifest:f.saved.manifest,expectedSha256:f.saved.sha256,readPage:f.readPage,budget:f.budget}),/prune-page-integrity/);
 f.objects.set(key,original);
 const manifest=clone(f.saved.manifest),page=JSON.parse(original.toString());page.records[1].sequence=3;page.records[1].id=id(3);
 const bytes=Buffer.from(canonical(page));f.objects.set(key,bytes);manifest.pages[0].sha256=snapshotHash(bytes);
 await assert.rejects(()=>verifyFeedPrunePlan({manifest,expectedSha256:snapshotHash(manifest),readPage:f.readPage,budget:f.budget}),/prune-plan-gap/);
});

test('resumed runner reauthenticates immutable plan pages and rejects publication or progress substitution',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state);await step(f,adapter);const before=clone(adapter.state);
 const key=f.saved.manifest.pages[1].key;f.objects.set(key,Buffer.from('tampered'));
 await assert.rejects(()=>step(f,adapter),/prune-page-integrity/);assert.deepEqual(adapter.state,before);
 await assert.rejects(()=>step(f,adapter,{plan:{manifest:f.plan.manifest,sha256:f.plan.sha256,pageAt:f.plan.pageAt}}),/verified-pruner-required/);
 await adapter.mutate(state=>{state.run.pruneProgress.planSha256='a'.repeat(64);});
 await assert.rejects(()=>step(f,adapter),/prune-(plan-changed|progress-invalid)/);assert.equal(adapter.committedDeletes.length,20);
});

test('every cleanup acceptance gate fails before deletes, including malformed or future protocol state',async t=>{
 const f=await fixture(t);
 const cases=[
  ['deleting tenant',state=>{state.root.adminDeleting=true;}],
  ['disabled tenant',state=>{state.root.enabled=false;}],
  ['wrong checkpoint',state=>{state.run.checkpoint.sequence--;}],
  ['root rolled back below checkpoint',state=>{state.root.sequence=C-1;}],
  ['floor above checkpoint',state=>{state.root.historyFloor=C+1;}],
  ['future minimum protocol',state=>{state.root.minimumSyncProtocol=3;}],
  ['expired lease',state=>{state.run.lease.expiresAtMs=now;}],
  ['unparseable lease expiry',state=>{delete state.run.lease.expiresAtMs;}],
  ['stale fencing token',state=>{state.run.lease.fence++;}],
  ['changed lease owner',state=>{state.run.lease.owner='another_operator';}],
  ['financial mismatch',state=>{state.run.evidence.verified.financialMatch=false;}],
  ['identity mismatch',state=>{state.run.evidence.verified.identitiesMatch=false;}],
  ['unfinished grace period',state=>{state.run.evidence.verified.verifiedAtMs=now-89*86_400_000;}],
  ['wrong snapshot',state=>{state.run.evidence.activeSnapshot.headerSha256='b'.repeat(64);}],
  ['unverified snapshot',state=>{state.run.evidence.activeSnapshot.verified=false;}],
  ['wrong source digest',state=>{state.run.evidence.activeSnapshot.sourceDocumentHashesSha256='c'.repeat(64);}],
  ['wrong accepted plan',state=>{state.run.evidence.cleanupAcceptance.planSha256='d'.repeat(64);}],
  ['independent recovery missing',state=>{state.run.evidence.cleanupAcceptance.independentRecovery=false;}],
  ['key recovery missing',state=>{state.run.evidence.cleanupAcceptance.keyRecoveryTested=false;}],
  ['retention proof missing',state=>{state.run.evidence.cleanupAcceptance.retentionChecked=false;}],
  ['unresolved dependencies',state=>{state.run.evidence.cleanupAcceptance.dependenciesResolved=false;}],
  ['protocol acceptance missing',state=>{state.run.evidence.cleanupAcceptance.protocolAcceptance=false;}],
  ['install acceptance missing',state=>{state.run.evidence.cleanupAcceptance.clientInstallAcceptance=false;}],
  ['another source consumer still active',state=>{state.root.archivePolicy.pendingFeedConsumers=[C-1];}],
  ['undefined checkpoint version in all copies',state=>{delete state.run.checkpoint.version;delete state.run.evidence.verified.closingVersion;delete state.run.evidence.cleanupAcceptance.closingVersion;}],
  ['missing manifest hash in all copies',state=>{delete state.run.manifest.sha256;delete state.run.evidence.verified.manifestSha256;delete state.run.evidence.cleanupAcceptance.manifestSha256;}],
  ['complete without durable cursor',state=>{state.run.state='complete';}],
  ['invalid saved page',state=>{state.run.pruneProgress={page:99,deleted:0,planSha256:f.saved.sha256};}],
  ['invalid deleted count',state=>{state.run.pruneProgress={page:1,deleted:19,planSha256:f.saved.sha256};}],
 ];
 for(const [label,mutation]of cases){
  const adapter=new SyntheticPruneAdapter(f.state);await adapter.mutate(mutation);const before=clone(adapter.state);
  await assert.rejects(()=>step(f,adapter),undefined,label);assert.equal(adapter.committedDeletes.length,0,label);assert.deepEqual(adapter.state,before,label);
 }
 const adapter=new SyntheticPruneAdapter(f.state);
 await assert.rejects(()=>step(f,adapter,{config:{cleanupEnabled:false,graceDays:90}}),/cleanup-disabled/);
 await assert.rejects(()=>step(f,adapter,{storage:{kind:'directory'}}),/synthetic-cleanup-boundary/);
 await assert.rejects(()=>step(f,adapter,{mode:'production'}),/verified-pruner-required/);
 await assert.rejects(()=>step(f,adapter,{tenantId:'other'}),/prune-scope-mismatch/);
 await assert.rejects(()=>step(f,adapter,{year:2027}),/prune-scope-mismatch/);
});

test('tenant deletion, stale lease and floor advances between preflight and deletion recheck abort the transaction',async t=>{
 const f=await fixture(t);
 for(const mutation of [state=>{state.root.adminDeleting=true;},state=>{state.run.lease.fence++;},state=>{state.root.historyFloor=C+1;}]){
  const adapter=new SyntheticPruneAdapter(f.state);let changed=false;
  f.setReadHook(async()=>{if(!changed){changed=true;await adapter.mutate(mutation);}});
  await assert.rejects(()=>step(f,adapter));assert.equal(adapter.committedDeletes.length,0);assert.equal(adapter.state.run.pruneProgress,undefined);
 }
 f.setReadHook(null);
});

test('concurrent financial writes above C survive and a racing second runner cannot delete an already committed page',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state);let wrote=false;
 f.setReadHook(async()=>{if(!wrote){wrote=true;await adapter.mutate(state=>{
  const sequence=++state.root.sequence,payload=sale('concurrent');state.feed.set(id(sequence),{id:id(sequence),data:{entity:'entry',id:payload.id,payload,sequence,acceptedAtMs:now,closeVersion:1},updateTime:{seconds:1_800_000_000,nanoseconds:0}});state.entries.push(payload);state.operations.push({id:'concurrent_operation',status:'accepted'});
 });}});
 const outcomes=await Promise.allSettled([step(f,adapter),step(f,adapter)]);
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);
 assert.match(outcomes.find(result=>result.status==='rejected').reason.message,/prune-progress-changed/);assert.equal(adapter.committedDeletes.length,20);
 f.setReadHook(null);await step(f,adapter);await step(f,adapter);
 assert.equal(adapter.state.root.sequence,C+3);assert.ok(adapter.state.feed.has(id(C+3)));assert.ok(adapter.state.entries.some(entry=>entry.id==='concurrent'));assert.ok(adapter.state.operations.some(operation=>operation.id==='concurrent_operation'));
});

test('shared budget exhaustion defers before provider transactions or storage I/O',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state);let reads=0;
 f.setReadHook(async()=>{reads++;});
 await assert.rejects(()=>step(f,adapter,{budget:{reserve:async()=>{throw new Error('synthetic budget exhausted');}}}),/synthetic budget exhausted/);
 assert.equal(adapter.transactions,0);assert.equal(reads,0);assert.equal(adapter.committedDeletes.length,0);
});

test('a partial or completed run refuses a regressed published floor or minimum protocol',async t=>{
 const f=await fixture(t),partial=new SyntheticPruneAdapter(f.state);await step(f,partial);
 for(const mutation of [state=>{state.root.historyFloor=0;},state=>{state.root.minimumSyncProtocol=1;}]){
  const resumed=new SyntheticPruneAdapter(partial.state);await resumed.mutate(mutation);const before=clone(resumed.state);
  await assert.rejects(()=>step(f,resumed));assert.deepEqual(resumed.state,before);assert.equal(resumed.committedDeletes.length,0);
 }
 await step(f,partial);await step(f,partial);assert.equal(partial.state.run.state,'complete');
 await partial.mutate(state=>{state.root.historyFloor=0;});await assert.rejects(()=>step(f,partial));
});

test('an annual year that has not ended in Cairo cannot be pruned even with otherwise accepted evidence',async t=>{
 const f=await fixture(t),adapter=new SyntheticPruneAdapter(f.state),time=Date.parse('2027-08-31T20:00:00Z');
 await adapter.mutate(state=>{state.run.lease.expiresAtMs=time+60_000;state.run.evidence.verified.verifiedAtMs=time-91*86_400_000;});
 await assert.rejects(()=>step(f,adapter,{lease:{...f.args.lease,expiresAtMs:time+60_000},now:()=>time}));
 assert.equal(adapter.committedDeletes.length,0);
});

test('production adapter rejects synthetic, unaccepted storage or missing explicit production acceptance',async t=>{
 const f=await fixture(t);let writes=0;
 const ref=path=>({path,collection:name=>({doc:key=>ref(`${path}/${name}/${key}`)})});
 for(const scenario of [
  {storage:{kind:'synthetic',productionDurabilityAccepted:false},productionAcceptance:true,approvalId:'operator_acceptance'},
  {storage:{kind:'r2',productionDurabilityAccepted:false},productionAcceptance:true,approvalId:'operator_acceptance'},
  {storage:{kind:'r2',productionDurabilityAccepted:true},productionAcceptance:false,approvalId:'operator_acceptance'},
  {storage:{kind:'r2',productionDurabilityAccepted:true},productionAcceptance:true,approvalId:null},
 ]){
  const state=clone(f.state);Object.assign(state.run.evidence.cleanupAcceptance,{productionAcceptance:scenario.productionAcceptance,approvalId:scenario.approvalId});
  const db={doc:ref,runTransaction:async(fn,options)=>{
   assert.equal(options.maxAttempts,5);return fn({get:async value=>({exists:true,data:()=>clone(value.path.includes('/archiveRuns/')?state.run:state.root)}),update:()=>{writes++;},set:()=>{writes++;},delete:()=>{writes++;}});
  }};
  const adapter=new FirestoreFeedPruneAdapter(db);
  await assert.rejects(()=>step(f,adapter,{mode:'production',storage:scenario.storage}),/production-cleanup-not-accepted/);
 }
 assert.equal(writes,0);
});

test('bounded provider source reserves before every query and captures provider update versions',async t=>{
 const f=await fixture(t),calls=[];let after=0,pageSize=0;
 const query={where(_field,operator,value){if(operator==='>')after=value;return this;},orderBy(){return this;},limit(value){pageSize=value;return this;},async get(){calls.push('query');return {docs:f.rows.filter(row=>row.data.sequence>after&&row.data.sequence<=C).slice(0,pageSize).map(row=>({id:row.id,data:()=>row.data,updateTime:row.updateTime}))};}};
 const budget={reserve:async request=>{calls.push('reserve');assert.ok(request.costs.firestoreReads>=pageSize||!pageSize);}};
 const db={doc:()=>({collection:()=>query})},rows=[];
 for await(const row of immutableFeedDocumentsForPlan(db,{tenantId,fromSequence:0,checkpointSequence:C,budget,pageSize:10}))rows.push(row);
 assert.deepEqual(rows,f.rows.slice(0,C));assert.deepEqual(calls,['reserve','query','reserve','query','reserve','query','reserve','query','reserve','query']);
 let queries=0;
 await assert.rejects(async()=>{for await(const _ of immutableFeedDocumentsForPlan({doc:()=>{queries++;return null;}},{tenantId,fromSequence:0,checkpointSequence:C,budget:{reserve:async()=>{throw new Error('budget stop');}}})){}},/budget stop/);
 assert.equal(queries,0);
});
