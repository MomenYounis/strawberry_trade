import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalViewer} from '../src/historical-view.mjs';
import {exportArchive} from '../src/archive-format.mjs';
import {ArchiveControlReader} from '../src/archive-accounting.mjs';
import {SyntheticArchiveStorage} from '../src/archive-storage.mjs';

async function fixture({count=4}={}) {
  const tenantId='synthetic_archive_view',year=2026,masterKey=Buffer.alloc(32,27);
  const context={tenantId,year,runId:'run_view',closingSequence:count,closingVersion:1,
    previousCloseHash:null,keyId:'synthetic_key',createdAtMs:Date.parse('2027-09-01T00:00:00Z')};
  const records=[{type:'opening',tenantId,year,sequence:0,payload:{id:'recorded_net',role:'cash_movement',balanceMinor:0}},
    {type:'opening',tenantId,year,sequence:0,payload:{id:'customer',role:'merchant',balanceMinor:0}}];
  for(let i=1;i<=count;i++)records.push({type:'entry',tenantId,year,sequence:i,payload:{id:`invoice_${i}`,tenantId,kind:'sale',date:'2026-10-01',partyId:'customer',qtyMilli:1000,priceMinor:10000,totalMinor:10000,paidMinor:0,unit:'كجم',grade:'أول',note:'دليل '.repeat(30)}});
  const reader=new ArchiveControlReader(context);records.forEach(row=>reader.accept(row));
  const storage=new SyntheticArchiveStorage();
  const exported=await exportArchive({storage,masterKey,context,records,trustedControls:reader.finish(),assertLease:async()=>{},chunkBytes:1024});
  const run={tenantId,year,runId:context.runId,state:'verified',checkpoint:{sequence:count,version:1},
    manifest:{key:exported.manifestKey,sha256:exported.manifestSha256},evidence:{uploaded:{keyId:context.keyId},
      verified:{manifestSha256:exported.manifestSha256,financialMatch:true,identitiesMatch:true}}};
  const catalog={get:async()=>run,list:async()=>({runs:[run],nextYear:null})};
  const viewer=createHistoricalViewer({catalog,storage,keyResolver:async()=>masterKey,chunksPerRequest:1});
  return {tenantId,year,masterKey,storage,run,catalog,viewer,records};
}

test('repeated invoice reads retain identity and never offer a financial posting API',async()=>{
  const f=await fixture();
  const before=JSON.stringify(f.run);const bytesBefore=[...f.storage.objects.keys()];
  for(let visit=0;visit<3;visit++) {
    let nextChunk=0,result;
    do{result=await f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_4',nextChunk});nextChunk=result.nextChunk;}while(result.status==='continue');
    assert.equal(result.status,'found');assert.equal(result.record.id,'invoice_4');
    assert.equal(result.record.archived,true);assert.equal(result.record.readOnly,true);
  }
  assert.equal(JSON.stringify(f.run),before);assert.deepEqual([...f.storage.objects.keys()],bytesBefore);
  assert.deepEqual(Object.keys(f.viewer).sort(),['list','readRecord']);assert.ok(f.masterKey.every(n=>n===27));
});

test('catalogue listing exposes no key, object location or financial payload',async()=>{
  const f=await fixture();const page=await f.viewer.list({tenantId:f.tenantId});
  assert.equal(page.archives.length,1);assert.equal(page.archives[0].year,2026);
  for(const forbidden of ['keyId','manifest','evidence','record','masterKey'])assert.ok(!Object.hasOwn(page.archives[0],forbidden));
  f.run.state='exporting';assert.deepEqual(await f.viewer.list({tenantId:f.tenantId}),{archives:[],nextYear:null});
});

test('wrong tenant/year, unverified publication and wrong key fail before returning records',async()=>{
  const f=await fixture();
  await assert.rejects(f.viewer.readRecord({tenantId:'another_tenant',year:f.year,recordId:'invoice_1'}),/archive-not-published/);
  await assert.rejects(f.viewer.readRecord({tenantId:f.tenantId,year:2027,recordId:'invoice_1'}),/archive-not-published/);
  f.run.evidence.verified.financialMatch=false;
  await assert.rejects(f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_1'}),/archive-not-published/);
  f.run.evidence.verified.financialMatch=true;
  const wrong=createHistoricalViewer({...f,keyResolver:async()=>Buffer.alloc(32,0)});
  await assert.rejects(wrong.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_1'}),/manifest-authentication-failed/);
});

test('bounded reads require explicit continuation and absent IDs terminate',async()=>{
  const f=await fixture();const originalRead=f.storage.read.bind(f.storage);let reads=0;
  f.storage.read=async(...args)=>{reads++;return originalRead(...args);};
  let result=await f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'absent'});
  assert.equal(result.status,'continue');assert.equal(reads,2); // one bounded manifest + one bounded chunk
  let steps=1;
  while(result.status==='continue'){result=await f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'absent',nextChunk:result.nextChunk});steps++;}
  assert.equal(result.status,'not_found');assert.ok(steps>1&&steps<10);
  await assert.rejects(f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_1',nextChunk:999}),/invalid-archive-cursor/);
});

test('tampered stored manifest and interrupted storage do not return unverified contents',async()=>{
  const f=await fixture();const key=f.run.manifest.key;
  const bytes=f.storage.objects.get(key);f.storage.objects.set(key,Buffer.from(bytes).fill(0,0,1));
  await assert.rejects(f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_1'}),/manifest-integrity-failed/);
  f.storage.read=async()=>{throw new Error('synthetic-storage-outage');};
  await assert.rejects(f.viewer.readRecord({tenantId:f.tenantId,year:f.year,recordId:'invoice_1'}),/synthetic-storage-outage/);
});
