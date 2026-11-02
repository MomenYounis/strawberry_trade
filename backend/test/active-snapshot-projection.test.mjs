import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../src/validation.mjs';
import {createActiveSnapshotProjection,isVerifiedManagerSnapshotProjection,immutableActiveChangesAtCheckpoint,captureActiveSnapshotScope} from '../src/active-snapshot-projection.mjs';
import {createActiveSnapshotPackage,createActiveSnapshotService} from '../src/active-snapshot-service.mjs';
import {snapshotHash,snapshotContentHash} from '../src/active-snapshot-format.mjs';

const scope=(overrides={})=>({snapshotId:'source',tenantId:'tenant',uid:'manager',role:'manager',membershipEpoch:1,checkpointSequence:9,historyFloor:0,...overrides});
const sale=(id,extra={})=>({id,tenantId:'tenant',kind:'sale',partyId:'party',partyName:'عميل',qtyMilli:1000,priceMinor:500,totalMinor:500,paidMinor:0,unit:'kg',grade:'A',date:'2026-09-01',note:'',creatorUid:'manager',revision:1,...extra});
const submission=(id,uid,extra={})=>({id,tenantId:'tenant',creatorUid:uid,employeeId:'employee',kind:'delivery',date:'2026-09-01',partyId:'party',partyName:'عميل',qtyMilli:1000,grade:'A',unit:'kg',amountMinor:0,note:'',status:'pending',recordedByUid:uid,recordedAtMs:1,...extra});
function changes(){
 const rows=[['party',{id:'party',tenantId:'tenant',name:'عميل',kind:'merchant',phone:'',openingMinor:-300,favorite:true,revision:1}],
 ['employee',{id:'employee',tenantId:'tenant',name:'موظف',phone:'',active:true,revision:1}],
 ['salary_term',{id:'salary',tenantId:'tenant',employeeId:'employee',effectiveMonth:'2026-09',monthlyMinor:5000,revision:1}],
 ['entry',sale('sale')],['submission',submission('own','worker')],['submission',submission('other','other_worker')],
 ['review',{id:'review',tenantId:'tenant',submissionId:'own',decision:'approved',note:'',reviewerUid:'manager',reviewedAtMs:2,entryId:'approved'}],
 ['entry',sale('approved',{creatorUid:'worker',employeeId:'',submittedByEmployeeId:'employee'})],['submission',submission('own','worker',{status:'approved',reviewNote:'مقبول'})]];
 return rows.map(([entity,payload],index)=>({entity,id:payload.id,payload,sequence:index+1}));
}
const collect=async iterable=>{const values=[];for await(const value of iterable)values.push(value);return values;};
async function prepared(t,{projectionScope=scope(),source=changes(),seed=null,...limits}={}){
 const projection=await createActiveSnapshotProjection({scope:projectionScope,seed,...limits});t.after(()=>projection.destroy());
 await projection.ingest(source);return projection;
}
async function packaged(projection){
 const objects=new Map();const publication=await createActiveSnapshotPackage({projection,writePage:async(index,bytes)=>{const key=`${projection.scope.snapshotId}/${index}`;assert.ok(!objects.has(key));objects.set(key,Buffer.from(bytes));return {key};}});
 return {objects,publication,readPage:async index=>JSON.parse(objects.get(publication.pages[index].key).toString())};
}

test('full manager projection seals a unique latest image and employee view removes financial data',async t=>{
 const manager=await prepared(t);assert.equal(isVerifiedManagerSnapshotProjection(manager),true);assert.equal(manager.checkpointSequence,9);
 assert.equal(manager.sourceFromSequence,0);assert.equal(manager.sourceFeedSha256,snapshotHash(changes().map(row=>canonical(row)+'\n').join('')));
 assert.equal(manager.sourceDocumentHashesSha256,snapshotHash(changes().map(row=>snapshotHash(row)+'\n').join('')));
 const full=await collect(manager.iterateFullRecords());assert.equal(full.length,8);
 assert.deepEqual(full.find(row=>row.id==='own').payload.status,'approved');assert.equal(full.find(row=>row.id==='own').sequence,9);
 const employee=await prepared(t,{projectionScope:scope({snapshotId:'employee_source',uid:'worker',role:'employee'})});
 assert.equal(isVerifiedManagerSnapshotProjection(employee),false);const rows=await collect(employee.records());
 assert.deepEqual(rows.map(row=>row.entity),['party','submission']);assert.equal(rows[1].payload.creatorUid,'worker');
 assert.deepEqual(Object.keys(rows[0].payload).sort(),['favorite','id','kind','name','phone','revision','tenantId']);
 assert.equal(JSON.stringify(rows).includes('openingMinor'),false);await assert.rejects(()=>collect(employee.iterateFullRecords()),/snapshot-projection-denied/);
 await manager.destroy();assert.equal(isVerifiedManagerSnapshotProjection(manager),false);
});

test('projection requires complete contiguous feed, closes after failures and never accepts immutable rewrites',async t=>{
 for(const source of [changes().slice(1),changes().slice(0,-1),[{...changes()[0],sequence:10}]]){
  const projection=await createActiveSnapshotProjection({scope:scope()});t.after(()=>projection.destroy());
  await assert.rejects(()=>projection.ingest(source),/snapshot-history-gap/);assert.equal(isVerifiedManagerSnapshotProjection(projection),false);
  await assert.rejects(()=>projection.ingest(changes()),/snapshot-source-closed/);
 }
 const rewrite=[changes()[0],{...changes()[0],sequence:2}];
 await assert.rejects(()=>prepared(t,{projectionScope:scope({checkpointSequence:2}),source:rewrite}),/snapshot-immutable-rewrite/);
 await assert.rejects(()=>prepared(t,{maxChanges:1}),/snapshot-source-limit/);
 await assert.rejects(()=>prepared(t,{maxBytes:1024}),/snapshot-source-limit/);
 const bad=changes();bad[8].payload={...bad[8].payload,qtyMilli:2000};
 await assert.rejects(()=>prepared(t,{source:bad}),/snapshot-submission-rewrite/);
});

test('trusted full manager seed resumes from C and employee seed or wrong hash cannot authorize continuation',async t=>{
 const first=await prepared(t),saved=await packaged(first);
 const seed={header:saved.publication.header,expectedHeaderSha256:saved.publication.headerSha256,readPage:saved.readPage};
 const next={entity:'entry',id:'next',payload:sale('next'),sequence:10};
 const resumed=await prepared(t,{projectionScope:scope({snapshotId:'next_source',checkpointSequence:10,historyFloor:9}),source:[next],seed});
 assert.equal(resumed.seedSequence,9);assert.equal(resumed.checkpointSequence,10);assert.equal((await collect(resumed.iterateFullRecords())).length,9);
 assert.equal(resumed.sourceFromSequence,9);assert.equal(resumed.sourceFeedSha256,snapshotHash(canonical(next)+'\n'));
 assert.equal(resumed.sourceDocumentHashesSha256,snapshotHash(snapshotHash(next)+'\n'));
 assert.equal(isVerifiedManagerSnapshotProjection(resumed),true);
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope({historyFloor:1})}),/snapshot-seed-required/);
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{...seed,expectedHeaderSha256:'a'.repeat(64)}}),/trusted-snapshot-seed-required/);
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope({checkpointSequence:8}),seed}),/snapshot-seed-checkpoint-mismatch/);
 const employee=await prepared(t,{projectionScope:scope({snapshotId:'employee_source',uid:'worker',role:'employee'})}),employeeSaved=await packaged(employee);
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{header:employeeSaved.publication.header,expectedHeaderSha256:employeeSaved.publication.headerSha256,readPage:employeeSaved.readPage}}),/wrong-snapshot-scope/);
});

test('seed validates all pages, final digest, record count and collision uniqueness before sealing',async t=>{
 const first=await prepared(t),saved=await packaged(first);const seed={header:saved.publication.header,expectedHeaderSha256:saved.publication.headerSha256,readPage:saved.readPage};
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{...seed,readPage:async index=>{const page=await saved.readPage(index);page.records[0].payload.name='tampered';return page;}}}),/snapshot-page-integrity/);
 const badHeader={...seed.header,contentSha256:'a'.repeat(64)};
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{...seed,header:badHeader,expectedHeaderSha256:snapshotHash(badHeader)}}),/snapshot-seed-integrity/);
 const countHeader={...seed.header,recordCount:9};
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{...seed,header:countHeader,expectedHeaderSha256:snapshotHash(countHeader)}}),/snapshot-seed-integrity/);
 const original=await saved.readPage(0),duplicate=structuredClone(original.records.find(row=>row.entity==='entry'));
 duplicate.sequence=9;const rows=[...original.records,duplicate].sort((a,b)=>a.entity<b.entity?-1:a.entity>b.entity?1:a.sequence-b.sequence);
 const duplicatePage={...original,records:rows,sha256:snapshotHash(rows)};
 const dupHeader={...seed.header,recordCount:rows.length,contentSha256:snapshotContentHash([{index:0,sha256:duplicatePage.sha256,recordCount:rows.length}])};
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope(),seed:{header:dupHeader,expectedHeaderSha256:snapshotHash(dupHeader),readPage:async()=>duplicatePage}}),/UNIQUE constraint/);
});

test('bounded package pages retain deterministic order and empty C=0 is valid',async t=>{
 const source=[changes()[0]];for(let index=1;index<=100;index++)source.push({entity:'entry',id:`sale_${index}`,sequence:index+1,payload:sale(`sale_${index}`,{note:'x'.repeat(900)})});
 const projection=await prepared(t,{projectionScope:scope({checkpointSequence:101}),source}),saved=await packaged(projection);
 assert.ok(saved.publication.pages.length>=2);assert.equal(saved.publication.header.recordCount,101);
 for(const bytes of saved.objects.values())assert.ok(bytes.length<=66_560);
 const seed={header:saved.publication.header,expectedHeaderSha256:saved.publication.headerSha256,readPage:saved.readPage};
 const restored=await prepared(t,{projectionScope:scope({snapshotId:'restored',checkpointSequence:101,historyFloor:101}),source:[],seed});
 assert.equal((await collect(restored.iterateFullRecords())).length,101);
 const pages=await Promise.all(saved.publication.pages.map((_,index)=>saved.readPage(index)));
 // Each page remains locally ordered and checksummed, while the page boundary
 // now moves backwards. A forged descriptor digest must not hide that gap.
 const backwards=[...pages].reverse().map((page,index)=>({...page,index}));
 const backwardsHeader={...seed.header,contentSha256:snapshotContentHash(backwards.map(page=>({index:page.index,sha256:page.sha256,recordCount:page.records.length})))};
 await assert.rejects(()=>createActiveSnapshotProjection({scope:scope({checkpointSequence:101}),seed:{header:backwardsHeader,expectedHeaderSha256:snapshotHash(backwardsHeader),readPage:async index=>backwards[index]}}),/snapshot-record-order/);
 const empty=await prepared(t,{projectionScope:scope({snapshotId:'empty',checkpointSequence:0}),source:[]}),emptyPackage=await packaged(empty);
 assert.equal(emptyPackage.publication.header.pageCount,0);assert.equal(emptyPackage.objects.size,0);
 await assert.rejects(()=>createActiveSnapshotPackage({projection:{scope:scope(),records:async function*(){}},writePage:async()=>({key:'no'})}),/snapshot-projection-required/);
 await assert.rejects(()=>createActiveSnapshotPackage({projection,writePage:async()=>{throw new Error('synthetic write failed');}}),/synthetic write failed/);
});

test('guarded service binds fresh manager UID and epoch to immutable new snapshot IDs',async t=>{
 const projection=await prepared(t),saved=await packaged(projection);let guards=0;const costs=[];
 const service=createActiveSnapshotService({catalog:{latest:async()=>saved.publication},storage:{read:async(key,{maxBytes})=>{assert.equal(maxBytes,66_560);return saved.objects.get(key);}},assertAuthority:async()=>{guards++;return true;},budget:{reserve:async value=>costs.push(value)}});
 const caller={tenantId:'tenant',uid:'new_manager',role:'manager',membershipEpoch:7};const result=await service.getHeader(caller);
 assert.equal(result.header.uid,'new_manager');assert.equal(result.header.membershipEpoch,7);assert.notEqual(result.header.snapshotId,'source');
 assert.equal(result.headerSha256,snapshotHash(result.header));
 const response=await service.readPage({...caller,snapshotId:result.header.snapshotId,index:0,headerSha256:result.headerSha256});
 assert.equal(response.page.snapshotId,result.header.snapshotId);assert.equal(response.headerSha256,result.headerSha256);
 assert.deepEqual(response.header,result.header);
 assert.ok(guards>=4);assert.ok(costs.some(value=>value.costs.downloadBytes===66_560));assert.ok(new Set(costs.map(value=>value.stepId)).size===costs.length);
 const epoch8=await service.getHeader({...caller,membershipEpoch:8});assert.notEqual(epoch8.header.snapshotId,result.header.snapshotId);
 await assert.rejects(()=>service.readPage({...caller,membershipEpoch:8,snapshotId:result.header.snapshotId,index:0,headerSha256:result.headerSha256}),/snapshot-publication-changed/);
});

test('trusted live history floor rejects stale snapshots and fresh-binds a raised floor at the same checkpoint',async t=>{
 const projection=await prepared(t),saved=await packaged(projection);
 const service=createActiveSnapshotService({catalog:{latest:async()=>saved.publication},storage:{read:async key=>saved.objects.get(key)}});
 const caller={tenantId:'tenant',uid:'manager',role:'manager',membershipEpoch:1};
 const before=await service.getHeader(caller),raised=await service.getHeader({...caller,minimumHistoryFloor:5});
 assert.equal(raised.header.checkpointSequence,9);assert.equal(raised.header.historyFloor,5);assert.notEqual(raised.header.snapshotId,before.header.snapshotId);
 const page=await service.readPage({...caller,minimumHistoryFloor:5,snapshotId:raised.header.snapshotId,index:0,headerSha256:raised.headerSha256});
 assert.deepEqual(page.header,raised.header);assert.equal(page.page.snapshotId,raised.header.snapshotId);
 await assert.rejects(()=>service.readPage({...caller,minimumHistoryFloor:5,snapshotId:before.header.snapshotId,index:0,headerSha256:before.headerSha256}),/snapshot-publication-changed/);
 await assert.rejects(()=>service.getHeader({...caller,minimumHistoryFloor:10}),/snapshot-checkpoint-below-history-floor/);
 await assert.rejects(()=>service.getHeader({...caller,minimumHistoryFloor:-1}));
 saved.publication.historyFloor=6;
 const lower=await service.getHeader({...caller,minimumHistoryFloor:1}),equal=await service.getHeader({...caller,minimumHistoryFloor:6});
 assert.deepEqual(lower,equal);assert.equal(lower.header.historyFloor,6);
});

test('service refuses cross-role or cross-UID employee data, corruption and authority revocation',async t=>{
 const employee=await prepared(t,{projectionScope:scope({snapshotId:'employee_source',uid:'worker',role:'employee'})}),saved=await packaged(employee);
 const caller={tenantId:'tenant',uid:'worker',role:'employee',membershipEpoch:3};let allowed=true;
 const service=createActiveSnapshotService({catalog:{latest:async()=>saved.publication},storage:{read:async key=>saved.objects.get(key)},assertAuthority:async()=>allowed});
 const header=await service.getHeader(caller);const response=await service.readPage({...caller,...header.header,index:0,headerSha256:header.headerSha256});
 assert.deepEqual(response.page.records.map(row=>row.entity),['party','submission']);assert.equal(response.page.records[1].payload.creatorUid,'worker');
 await assert.rejects(()=>service.getHeader({...caller,uid:'other_worker'}),/snapshot-projection-denied/);
 await assert.rejects(()=>service.getHeader({...caller,role:'manager'}),/wrong-snapshot-scope/);
 await assert.rejects(()=>service.getHeader({...caller,tenantId:'other_tenant'}),/wrong-snapshot-scope/);
 allowed=false;await assert.rejects(()=>service.getHeader(caller),/snapshot-authority-changed/);allowed=true;
 const key=saved.publication.pages[0].key,bytes=saved.objects.get(key);saved.objects.set(key,Buffer.from(bytes.toString().replace('عميل','تلاعب')));
 await assert.rejects(()=>service.readPage({...caller,snapshotId:header.header.snapshotId,index:0,headerSha256:header.headerSha256}),/snapshot-page-integrity/);
});

test('service detects catalog replacement and post-I/O authority loss without returning a page',async t=>{
 const projection=await prepared(t),saved=await packaged(projection);let latest=saved.publication,reads=0,allowed=true;
 const caller={tenantId:'tenant',uid:'manager',role:'manager',membershipEpoch:1};
 const service=createActiveSnapshotService({catalog:{latest:async()=>latest},storage:{read:async key=>{reads++;latest={...saved.publication,historyFloor:1};return saved.objects.get(key);}},assertAuthority:async()=>allowed});
 const header=await service.getHeader(caller);
 await assert.rejects(()=>service.readPage({...caller,snapshotId:header.header.snapshotId,index:0,headerSha256:header.headerSha256}),/snapshot-publication-changed/);assert.equal(reads,1);
 latest=saved.publication;const revoked=createActiveSnapshotService({catalog:{latest:async()=>latest},storage:{read:async key=>{allowed=false;return saved.objects.get(key);}},assertAuthority:async()=>allowed});
 await assert.rejects(()=>revoked.readPage({...caller,snapshotId:header.header.snapshotId,index:0,headerSha256:header.headerSha256}),/snapshot-authority-changed/);
 const bad={...saved.publication,pages:saved.publication.pages.map(value=>({...value,sha256:'a'.repeat(64)}))};
 await assert.rejects(()=>createActiveSnapshotService({catalog:{latest:async()=>bad},storage:{read:async()=>{throw new Error('must not read');}}}).getHeader(caller),/snapshot-descriptor-integrity/);
});

test('budget deferral happens before provider I/O and failed writes never return a publication',async t=>{
 const projection=await prepared(t),saved=await packaged(projection);let io=0;
 const budget={reserve:async()=>{throw new Error('synthetic budget exhausted');}};
 const service=createActiveSnapshotService({catalog:{latest:async()=>{io++;return saved.publication;}},storage:{read:async()=>{io++;return Buffer.alloc(0);}},budget});
 await assert.rejects(()=>service.getHeader({tenantId:'tenant',uid:'manager',role:'manager',membershipEpoch:1}),/synthetic budget exhausted/);
 await assert.rejects(()=>createActiveSnapshotPackage({projection,budget,writePage:async()=>{io++;return {key:'never'};}}),/synthetic budget exhausted/);assert.equal(io,0);
});

test('checkpoint source bounds each query and rejects missing history before yielding a seedless image',async()=>{
 const rows=changes();let after=0,limit=0,queries=0;
 const query={where(_field,operator,value){if(operator==='>')after=value;return this;},orderBy(){return this;},limit(value){limit=value;return this;},async get(){queries++;return {docs:rows.filter(row=>row.sequence>after).slice(0,limit).map(row=>({data:()=>row}))};}};
 const db={doc:()=>({collection:()=>query})};
 assert.equal((await collect(immutableActiveChangesAtCheckpoint(db,{tenantId:'tenant',checkpointSequence:9,pageSize:2}))).length,9);assert.equal(queries,5);
 await assert.rejects(()=>collect(immutableActiveChangesAtCheckpoint(db,{tenantId:'tenant',checkpointSequence:9,historyFloor:1})),/snapshot-seed-required/);
 await assert.rejects(()=>collect(immutableActiveChangesAtCheckpoint(db,{tenantId:'tenant',checkpointSequence:10,pageSize:2})),/snapshot-history-gap/);
 await assert.rejects(()=>collect(immutableActiveChangesAtCheckpoint(db,{tenantId:'tenant',checkpointSequence:9,pageSize:2,maxPages:1})),/snapshot-source-page-limit/);
});

test('checkpoint capture rejects tenant deletion, inactive employee and changed membership epoch',async()=>{
 let tenant={sequence:9,historyFloor:3},member={active:true,role:'employee',epoch:2,employeeId:'employee'},employee={active:true};
 const ref=path=>({path,collection:name=>({doc:id=>ref(`${path}/${name}/${id}`)})});
 const db={doc:ref,runTransaction:async fn=>fn({get:async value=>({data:()=>value.path.endsWith('/worker')?member:value.path.endsWith('/employee')?employee:tenant})})};
 const input={db,snapshotId:'captured',tenantId:'tenant',uid:'worker',role:'employee',membershipEpoch:2};
 assert.equal((await captureActiveSnapshotScope(input)).checkpointSequence,9);
 tenant={...tenant,adminDeleting:true};await assert.rejects(()=>captureActiveSnapshotScope(input),/snapshot-authority-changed/);tenant={sequence:9};
 employee={active:false};await assert.rejects(()=>captureActiveSnapshotScope(input),/snapshot-authority-changed/);employee={active:true};
 member={...member,epoch:3};await assert.rejects(()=>captureActiveSnapshotScope(input),/snapshot-authority-changed/);
});

test('checkpoint capture reserves its worst-case five-attempt read budget before provider I/O',async()=>{
 const events=[];let reads=0,reserved=0,providerCalls=0,attempts=0;
 const ref=path=>({path,collection:name=>({doc:key=>ref(`${path}/${name}/${key}`)})});
 const db={doc:ref,runTransaction:async(callback,options)=>{
  providerCalls++;events.push('provider');
  let result;
  // Simulate the SDK retrying four aborted read transactions, then succeeding.
  for(let attempt=0;attempt<5;attempt++){
   attempts++;
   result=await callback({get:async reference=>{
    reads++;assert.ok(reads<=reserved,'provider retry reads exceeded the pre-I/O reservation');events.push('read');
    const value=reference.path.includes('/members/')?{active:true,role:'employee',epoch:2,employeeId:'employee'}:
     reference.path.includes('/employees/')?{active:true}:{sequence:9,historyFloor:3};
    return {data:()=>value};
   }});
  }
  assert.equal(options?.maxAttempts,5,'SDK retries must not exceed the reserved attempt bound');
  return result;
 }};
 const budget={reserve:async request=>{
  assert.equal(reads,0);assert.equal(providerCalls,0);events.push('reserve');
  await Promise.resolve();reserved+=request.costs.firestoreReads;events.push('reserved');
 }};
 const input={db,snapshotId:'retry_budget',tenantId:'tenant',uid:'worker',role:'employee',membershipEpoch:2,budget};
 const captured=await captureActiveSnapshotScope(input);
 assert.equal(captured.checkpointSequence,9);assert.equal(captured.historyFloor,3);
 assert.equal(attempts,5);assert.equal(reads,15);assert.equal(reserved,15);
 assert.deepEqual(events.slice(0,3),['reserve','reserved','provider']);
 await assert.rejects(()=>captureActiveSnapshotScope({...input,budget:{reserve:async()=>{throw new Error('synthetic budget exhausted');}}}),/synthetic budget exhausted/);
 assert.equal(providerCalls,1,'budget exhaustion must defer before opening another provider transaction');
 assert.equal(reads,15);
});
