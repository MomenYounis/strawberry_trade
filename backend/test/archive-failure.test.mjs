import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,hkdfSync} from 'node:crypto';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
import {SyntheticArchiveStorage,R2ArchiveStorage,createTemporaryRestoreSink} from '../src/archive-storage.mjs';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {runArchiveExportStep} from '../src/archive-coordinator.mjs';
import {exportArchive,readArchiveManifest,readArchiveChunk,verifyArchive} from '../src/archive-format.mjs';
import {canonical} from '../src/validation.mjs';

const tenantId='synthetic_failure_tenant',masterKey=Buffer.alloc(32,42);
const entry=(id,date,extra={})=>({id,tenantId,kind:'sale',date,partyId:'customer',qtyMilli:10000,priceMinor:200000,totalMinor:2000000,paidMinor:0,unit:'kg',grade:'A',...extra});
const changes=[{sequence:1,entity:'party',id:'customer',payload:{id:'customer',tenantId,name:'Synthetic',kind:'merchant',openingMinor:0}},
 {sequence:2,entity:'entry',id:'invoice',payload:entry('invoice','2027-08-31')},
 {sequence:3,entity:'entry',id:'receipt',payload:entry('receipt','2027-09-03',{kind:'merchant_payment',qtyMilli:0,priceMinor:0,totalMinor:500000,paidMinor:500000,unit:'',grade:''})},
 {sequence:4,entity:'entry',id:'return',payload:entry('return','2027-09-04',{kind:'sale_return',originalId:'invoice',qtyMilli:2500,totalMinor:500000})}];
const sourceFactory=async context=>{const p=await createArchiveProjection({context});try{await p.ingest(changes.slice(0,context.closingSequence));return p;}catch(e){await p.destroy();throw e;}};

// These synthetic budget/storage adapters never establish production acceptance.
const budget={reserve:async()=>{}};
test('two consecutive verified annual packages link checkpoints and retain cross-year invoice references',async()=>{
 let now=Date.parse('2027-09-01T00:00:00Z');
 const adapter=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:2}}),store=new ArchiveStateStore(adapter,{now:()=>now}),storage=new SyntheticArchiveStorage();
 let priorHash=null;
 for(const year of [2026,2027]) {
   if(year===2027){now=Date.parse('2028-09-01T00:00:00Z');adapter.roots.get(tenantId).sequence=4;}
   await store.create({tenantId,year,runId:`run_${year}`});
   const lease=await store.acquire(tenantId,year,'runner');await store.checkpoint(tenantId,year,lease,{authorizedClose:true,exportEnabled:true});
   const result=await runArchiveExportStep({stateStore:store,tenantId,year,lease,sourceFactory,storage,masterKey,keyId:'synthetic_key',budget,now:()=>now});
   assert.equal(result.state,'verified');
   const m=await readArchiveManifest({storage,manifestKey:result.run.manifest.key,manifestSha256:result.run.manifest.sha256,masterKey,expected:{tenantId,year}});
   assert.equal(m.context.previousCloseHash,priorHash);
   assert.equal(m.controls.signedReceivablesMinor,year===2026?2000000:1000000);
   if(year===2027){assert.equal(m.controls.counts.reference,1);const account=m.controls.accounts.find(a=>a.role==='merchant');assert.equal(account.openingMinor,2000000);assert.equal(account.periodMinor,-1000000);}
   priorHash=result.run.manifest.sha256;
 }
 assert.equal(adapter.roots.get(tenantId).archivePolicy.closeVersion,2);
});

test('failure before each supported durable transition rolls back and retry preserves a single close',async()=>{
 const now=Date.parse('2027-09-01T00:00:00Z'),base=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:2}});
 let fail=false;
 const adapter={transaction:(tenant,year,fn)=>base.transaction(tenant,year,async tx=>{const result=await fn(tx);if(fail)throw new Error('injected-precommit');return result;})};
 const store=new ArchiveStateStore(adapter,{now:()=>now});
 fail=true;await assert.rejects(store.create({tenantId,year:2026,runId:'transition'}),/injected/);assert.equal(base.runs.size,0);
 fail=false;await store.create({tenantId,year:2026,runId:'transition'});const lease=await store.acquire(tenantId,2026,'runner');
 fail=true;await assert.rejects(store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true}),/injected/);assert.equal(base.roots.get(tenantId).archivePolicy,undefined);
 fail=false;await store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true});
 for(const [from,to,evidence] of [['checkpointed','exporting',{}],['exporting','uploaded',{key:'archives/v1/'+tenantId+'/2026/transition/manifests/'+'a'.repeat(64),sha256:'a'.repeat(64),keyId:'synthetic'}]]){
  fail=true;await assert.rejects(store.advance(tenantId,2026,lease,from,to,evidence),/injected/);assert.equal(base.runs.get(tenantId+'/2026').state,from);
  fail=false;await store.advance(tenantId,2026,lease,from,to,evidence);
 }
 const pointer={key:'archives/v1/'+tenantId+'/2026/transition/manifests/'+'a'.repeat(64),sha256:'a'.repeat(64)};
 fail=true;await assert.rejects(store.publishManifest(tenantId,2026,lease,pointer),/injected/);assert.equal(base.runs.get(tenantId+'/2026').manifest,undefined);
 fail=false;await store.publishManifest(tenantId,2026,lease,pointer);
 const evidence={verifier:'strawberry-restore-v1',manifestSha256:pointer.sha256,financialMatch:true,identitiesMatch:true,verifiedAtMs:now,tenantId,year:2026,runId:'transition',closingSequence:2,closingVersion:1,keyId:'synthetic'};
 fail=true;await assert.rejects(store.advance(tenantId,2026,lease,'uploaded','verified',evidence),/injected/);assert.equal(base.roots.get(tenantId).archivePolicy.lastVerifiedYear,undefined);
 fail=false;await store.advance(tenantId,2026,lease,'uploaded','verified',evidence);
 fail=true;await assert.rejects(store.advance(tenantId,2026,lease,'verified','cleanup_pending'),/injected/);
 fail=false;await store.advance(tenantId,2026,lease,'verified','cleanup_pending');
 assert.equal(base.roots.get(tenantId).archivePolicy.closeVersion,1);
});

async function fixture() {
 const context={tenantId,year:2026,runId:'malformed',closingSequence:2,closingVersion:1,keyId:'synthetic',previousCloseHash:null,createdAtMs:1};
 const p=await createArchiveProjection({context}),storage=new SyntheticArchiveStorage();
 await p.ingest(changes.slice(0,2).map(c=>c.entity==='entry'?{...c,payload:{...c.payload,note:'x'.repeat(600)}}:c));
 try{const controls=await p.trustedControls(),result=await exportArchive({storage,masterKey,context,records:p.records(),trustedControls:controls,assertLease:async()=>{},chunkBytes:1024});return {context,storage,controls,...result};}finally{await p.destroy();}
}
// Use the test key to create an authenticated but structurally malicious fixture.
// Ordinary attackers cannot manufacture this MAC; strict parsing still rejects it.
function replaceManifest(f,change) {
 const envelope=JSON.parse(f.storage.objects.get(f.manifestKey).toString());change(envelope.body);
 const key=Buffer.from(hkdfSync('sha256',masterKey,Buffer.from(`${tenantId}/malformed/synthetic`),Buffer.from('strawberry-archive-v1/manifest'),32));
 envelope.mac=createHmac('sha256',key).update(canonical(envelope.body)).digest('hex');key.fill(0);
 const bytes=Buffer.from(canonical(envelope)),sha256=createHash('sha256').update(bytes).digest('hex'),manifestKey=f.manifestKey.slice(0,-64)+sha256;
 f.storage.objects.set(manifestKey,bytes);return {manifestKey,manifestSha256:sha256};
}
test('authenticated missing/reordered chunks, truncation and invalid GCM tags fail validation',async()=>{
 const f=await fixture();
 const reordered=replaceManifest(f,m=>{m.chunks.reverse();});
 await assert.rejects(readArchiveManifest({storage:f.storage,...reordered,masterKey,expected:f.context}),/chunk/);
 const missing=replaceManifest(f,m=>{m.chunks.pop();});
 await assert.rejects(readArchiveManifest({storage:f.storage,...missing,masterKey,expected:f.context}),/count/);
 const m=await readArchiveManifest({storage:f.storage,manifestKey:f.manifestKey,manifestSha256:f.manifestSha256,masterKey,expected:f.context});
 const original=f.storage.objects.get(m.chunks[0].key);f.storage.objects.set(m.chunks[0].key,original.subarray(0,-1));
 await assert.rejects(readArchiveChunk({storage:f.storage,manifest:m,masterKey,index:0}),/integrity/);
 f.storage.objects.set(m.chunks[0].key,original);
 const badTag=replaceManifest(f,body=>{const d=body.chunks[0],bytes=Buffer.from(original);bytes[bytes.length-1]^=1;const hash=createHash('sha256').update(bytes).digest('hex');d.cipherSha256=hash;d.key=d.key.slice(0,-64)+hash;f.storage.objects.set(d.key,bytes);});
 await assert.rejects(verifyArchive({storage:f.storage,...badTag,masterKey,expected:f.context,trustedControls:f.controls,sink:await createTemporaryRestoreSink()}),/authentication/);
});

test('timed-out R2 downloads cancel an active stream and a late returned body',async()=>{
 const bytes=Buffer.from('synthetic'),sha=createHash('sha256').update(bytes).digest('hex'),path=`archives/v1/${tenantId}/2026/run/chunks/${sha}`;
 let activeCancelled=false;
 const active=new R2ArchiveStorage({put:async()=>({}),get:async()=>({size:bytes.length,body:new ReadableStream({cancel(){activeCancelled=true;}})})},{timeoutMs:100});
 await assert.rejects(active.read(path,{maxBytes:bytes.length}),/timeout/);assert.equal(activeCancelled,true);
 let resolve,lateCancelled=false;
 const late=new R2ArchiveStorage({put:async()=>({}),get:()=>new Promise(done=>{resolve=done;})},{timeoutMs:100});
 await assert.rejects(late.read(path,{maxBytes:bytes.length}),/timeout/);
 resolve({size:bytes.length,body:new ReadableStream({cancel(){lateCancelled=true;}})});
 await new Promise(done=>setTimeout(done,0));assert.equal(lateCancelled,true);
});

for(const mismatch of ['master-key','key-id'])test(`resume rejects changed ${mismatch} before additional objects and preserves original-key recovery`,async()=>{
 const now=Date.parse('2027-09-02T00:00:00Z'),year=2026;
 const fixtureChanges=[changes[0],...Array.from({length:3},(_,i)=>({sequence:i+2,entity:'entry',id:`resume_invoice_${i}`,payload:entry(`resume_invoice_${i}`,'2027-08-31',{note:'x'.repeat(600)})}))];
 const adapter=new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:fixtureChanges.length}}),store=new ArchiveStateStore(adapter,{now:()=>now}),storage=new SyntheticArchiveStorage();
 await store.create({tenantId,year,runId:`key_resume_${mismatch}`});const lease=await store.acquire(tenantId,year,'runner');
 await store.checkpoint(tenantId,year,lease,{authorizedClose:true,exportEnabled:true});
 const options={stateStore:store,tenantId,year,lease,storage,masterKey,keyId:'original_key',budget,chunkBytes:1024,now:()=>now,
  sourceFactory:async context=>{const p=await createArchiveProjection({context});try{await p.ingest(fixtureChanges);return p;}catch(error){await p.destroy();throw error;}}};
 const first=await runArchiveExportStep({...options,maxNewChunks:1});assert.equal(first.state,'exporting');
 const checkpoint=await store.read(tenantId,year),objects=[...storage.objects.keys()];assert.equal(checkpoint.exportProgress.chunks.length,1);
 const changed=mismatch==='master-key'?{masterKey:Buffer.alloc(32,43)}:{keyId:'replacement_key'};
 await assert.rejects(runArchiveExportStep({...options,...changed,maxNewChunks:8}),/archive-authentication-failed/);
 const afterFailure=await store.read(tenantId,year);
 assert.equal(afterFailure.state,'exporting');assert.equal(afterFailure.manifest,undefined);
 assert.deepEqual(afterFailure.checkpoint,checkpoint.checkpoint);assert.deepEqual(afterFailure.exportProgress,checkpoint.exportProgress);
 assert.deepEqual([...storage.objects.keys()],objects);
 const recovered=await runArchiveExportStep({...options,maxNewChunks:8});assert.equal(recovered.state,'verified');
 assert.equal(recovered.run.checkpoint.version,checkpoint.checkpoint.version);
 assert.equal(recovered.run.evidence.verified.financialMatch,true);
});
