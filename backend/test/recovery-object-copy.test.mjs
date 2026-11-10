import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,writeFile,rm,unlink,symlink,readdir,open,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonical} from '../src/validation.mjs';
import {ArchiveControlReader} from '../src/archive-accounting.mjs';
import {exportArchive,readArchiveManifest} from '../src/archive-format.mjs';
import {createFirestoreRecoverySource} from '../src/firestore-recovery-source.mjs';
import {exportFirestoreRecoveryImage} from '../src/firestore-recovery-image.mjs';
import {snapshotHash,snapshotContentHash} from '../src/active-snapshot-format.mjs';
import {encodeRecoveryObjectArtifacts,prepareRecoveryObjectCopy,copyRecoveryObjects,verifyRecoveryObjectDestination,RECOVERY_OBJECT_LIMITS} from '../src/recovery-object-copy.mjs';
import {createRecoveryObjectLocalJournal,openRecoveryObjectLocalJournal} from '../src/recovery-object-journal.mjs';
import {createRecoveryObjectLocalStorage,readRecoveryObjectHandleBounded} from '../src/recovery-object-local-storage.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),tenantId='recovery_tenant',projectId='demo-object-recovery',databaseId='(default)',readTime='2026-11-06T10:00:00.000000Z',now=Date.parse(readTime)+1000;
const imageKey=Buffer.alloc(32,17),archiveKey=Buffer.alloc(32,29),context={projectId,databaseId,tenantId,readTime};
const old='2026-11-06T09:00:00Z',root=`projects/${projectId}/databases/${databaseId}/documents/tenants/${tenantId}`;
const file=(storage,key)=>join(storage.directory,hash(key)+'.object');
function typed(value){if(value===null)return {nullValue:null};if(typeof value==='string')return {stringValue:value};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number')return {integerValue:String(value)};if(Array.isArray(value))return {arrayValue:{values:value.map(typed)}};return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([key,child])=>[key,typed(child)]))}};}
function document(name,payload){return {name,createTime:old,updateTime:old,fields:Object.fromEntries(Object.entries(payload).map(([key,child])=>[key,typed(child)]))};}
async function fixture(t,{mutateInventory,mutateCatalog,mutateArtifacts,snapshotPageCount=1,snapshotRecordsPerPage=40}={}){
 const sourceStorage=await createRecoveryObjectLocalStorage(),destination=await createRecoveryObjectLocalStorage(),journal=await createRecoveryObjectLocalJournal();
 t.after(async()=>{await journal.close();for(const value of [sourceStorage,destination,journal])await rm(value.directory,{recursive:true,force:true});});
 const archiveContext={tenantId,year:2026,runId:'original_run',closingSequence:12,closingVersion:1,previousCloseHash:null,keyId:'archive_key',createdAtMs:now};
 const records=[{type:'opening',tenantId,year:2026,sequence:0,payload:{id:'recorded_net',role:'cash_movement',balanceMinor:0}},{type:'opening',tenantId,year:2026,sequence:0,payload:{id:'customer',role:'merchant',balanceMinor:0}}];
 for(let index=1;index<=12;index++)records.push({type:'entry',tenantId,year:2026,sequence:index,payload:{id:'invoice_'+index,tenantId,kind:'sale',date:'2026-10-01',partyId:'customer',qtyMilli:1000,priceMinor:10000,totalMinor:10000,paidMinor:0,grade:'A',unit:'kg',note:'Synthetic '.repeat(30)}});
 const control=new ArchiveControlReader(archiveContext);for(const row of records)control.accept(row);
 const exported=await exportArchive({storage:sourceStorage,masterKey:archiveKey,context:archiveContext,records,trustedControls:control.finish(),chunkBytes:1024,assertLease:async()=>{}});
 const manifest=await readArchiveManifest({storage:sourceStorage,manifestKey:exported.manifestKey,manifestSha256:exported.manifestSha256,masterKey:archiveKey,expected:archiveContext});
 const manifestRaw=await sourceStorage.read(exported.manifestKey,{maxBytes:524288});
 const objects=[{key:exported.manifestKey,sha256:exported.manifestSha256,bytes:manifestRaw.length,keyIds:['archive_key'],children:manifest.chunks.map(child=>({key:child.key,sha256:child.cipherSha256}))},...manifest.chunks.map(child=>({key:child.key,sha256:child.cipherSha256,bytes:child.cipherBytes,keyIds:['archive_key'],children:[]}))];
 const snapshotId='snapshot_original',descriptors=[];let pageKey;
 for(let index=0;index<snapshotPageCount;index++){
  const pageRecords=snapshotPageCount===1?[{entity:'party',sequence:1,payload:{id:'customer',tenantId,name:'Customer',kind:'merchant',openingMinor:0,revision:1}}]:Array.from({length:snapshotRecordsPerPage},(_,offset)=>({entity:'entry',sequence:index*snapshotRecordsPerPage+offset+1,payload:{id:'expense_'+(index*snapshotRecordsPerPage+offset+1),tenantId,creatorUid:'manager',kind:'expense_home',date:'2026-10-01',totalMinor:100,paidMinor:100,category:'home',note:'n'.repeat(1000),revision:1}}));
  const page={snapshotId,index,records:pageRecords,sha256:snapshotHash(pageRecords)},raw=Buffer.from(canonical(page)),key=`snapshots/v1/${tenantId}/${snapshotId}/pages/${hash(raw)}`;pageKey??=key;
  await sourceStorage.putImmutable(key,raw);descriptors.push({index,key,sha256:page.sha256,recordCount:pageRecords.length});objects.push({key,sha256:hash(raw),bytes:raw.length,keyIds:[],children:[]});
 }
 const count=snapshotPageCount===1?1:snapshotPageCount*snapshotRecordsPerPage,header={format:'active_snapshot',version:1,syncProtocolVersion:2,snapshotId,tenantId,role:'manager',uid:'manager',membershipEpoch:1,checkpointSequence:count,historyFloor:0,pageCount:snapshotPageCount,recordCount:count,contentSha256:snapshotContentHash(descriptors)};
 const publication=Buffer.from(canonical({header,headerSha256:snapshotHash(header),pages:descriptors,historyFloor:0})),publicationHash=hash(publication),publicationKey=`snapshots/v1/${tenantId}/${snapshotId}/manifests/${publicationHash}`;
 await sourceStorage.putImmutable(publicationKey,publication);
 objects.push({key:publicationKey,sha256:publicationHash,bytes:publication.length,keyIds:[],children:descriptors.map(page=>({key:page.key,sha256:page.key.split('/').at(-1)}))});
 const rows={[root]:document(root,{enabled:true,ownerUid:'manager'}),[root+'/archiveRuns/year_2026']:document(root+'/archiveRuns/year_2026',{manifest:{key:exported.manifestKey,sha256:exported.manifestSha256},keyId:'archive_key'})};
 const server=createServer(async(req,res)=>{const url=new URL(req.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname.slice(4));let body='';for await(const part of req)body+=part;let value;if(path.endsWith(':listCollectionIds'))value={collectionIds:path.slice(0,-18)===root?['archiveRuns']:[]};else if(rows[path])value=rows[path];else value={documents:Object.entries(rows).filter(([name])=>name.startsWith(path+'/')&&name.slice(path.length+1).split('/').length===1).map(([,row])=>row)};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const source=()=>createFirestoreRecoverySource({...context,endpoint:`http://127.0.0.1:${server.address().port}`,allowLoopbackForTests:true,accessToken:async()=>'synthetic-token',now:()=>now});
 const proof=await source().capture({writeRecord:()=>{}}),binding={...context,documentsSha256:proof.documentsSha256},catalogRoots=[{key:publicationKey,sha256:publicationHash}];
 mutateInventory?.(objects);mutateCatalog?.(catalogRoots);
 const artifacts=encodeRecoveryObjectArtifacts({source:binding,objectRoots:catalogRoots,objects});mutateArtifacts?.(artifacts);await sourceStorage.putImmutable(artifacts.snapshotCatalog.key,artifacts.catalog);await sourceStorage.putImmutable(artifacts.objectClosure.key,artifacts.closure);
 const image=await exportFirestoreRecoveryImage({source:source(),storage:sourceStorage,masterKey:imageKey,imageId:'capture_objects',keyId:'image_key',createdAtMs:now,dependencyEvidence:{snapshotCatalog:artifacts.snapshotCatalog,objectClosure:artifacts.objectClosure}});
 const imageOptions={storage:sourceStorage,manifestKey:image.manifestKey,manifestSha256:image.manifestSha256,masterKey:imageKey,expected:{...context,imageId:'capture_objects',keyId:'image_key'}};
 const options={image:imageOptions,sourceStorage,resolveArchiveKey:async keyId=>{assert.equal(keyId,'archive_key');return archiveKey;}};
 return {sourceStorage,destination,journal,objects,artifacts,options,imageOptions,exported,pageKey,publicationKey,prepare:overrides=>prepareRecoveryObjectCopy({...options,...overrides})};
}

test('authenticates actual image, archive manifest and snapshot catalog bytes before immutable copy and independent verification',async t=>{
 const f=await fixture(t),plan=await f.prepare();assert.ok(plan.objectCount>10);assert.deepEqual(plan.keyIds,['archive_key','image_key']);assert.equal(plan.productionRecoveryAccepted,false);assert.equal(plan.activationAllowed,false);assert.ok(Object.isFrozen(plan.keyIds));
 const copied=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal});assert.equal(copied.complete,true);assert.equal(copied.state,'verified_quarantine');assert.equal(copied.productionRecoveryAccepted,false);
 for(const item of f.objects)assert.deepEqual(await f.destination.read(item.key,{maxBytes:item.bytes}),await f.sourceStorage.read(item.key,{maxBytes:item.bytes}));
 const independent=await verifyRecoveryObjectDestination({plan,destinationStorage:f.destination});assert.equal(independent.byteIntegrityVerified,true);assert.equal(independent.objects,f.objects.length+2);assert.equal(f.destination.synthetic,true);assert.equal(f.destination.productionDurabilityAccepted,false);
 assert.deepEqual(await f.destination.read(f.artifacts.snapshotCatalog.key,{maxBytes:f.artifacts.catalog.length}),f.artifacts.catalog);assert.deepEqual(await f.destination.read(f.artifacts.objectClosure.key,{maxBytes:f.artifacts.closure.length}),f.artifacts.closure);
 await assert.rejects(copyRecoveryObjects({plan:structuredClone(plan),destinationStorage:f.destination,journal:f.journal}),/prepared|copy-arguments/);
});

test('durable partial progress resumes after reopening journal and reauthenticating image',async t=>{
 const f=await fixture(t),plan=await f.prepare(),partial=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal,maxObjectsPerInvocation:2});assert.equal(partial.nextObject,2);assert.equal(partial.complete,false);await f.journal.close();
 const reopened=await openRecoveryObjectLocalJournal({directory:f.journal.directory});t.after(()=>reopened.close());const fresh=await f.prepare();assert.equal(fresh.copyPlanSha256,plan.copyPlanSha256);
 const result=await copyRecoveryObjects({plan:fresh,destinationStorage:f.destination,journal:reopened});assert.equal(result.objectsCopiedThisInvocation,plan.objectCount-2);assert.equal(result.complete,true);
});

test('actual SIGKILL after first durable object resumes on a fresh process without duplicate or incomplete acceptance',async t=>{
 const f=await fixture(t);await f.journal.close();
 const child=`import {openRecoveryObjectLocalStorage} from './src/recovery-object-local-storage.mjs';import {openRecoveryObjectLocalJournal} from './src/recovery-object-journal.mjs';import {prepareRecoveryObjectCopy,copyRecoveryObjects} from './src/recovery-object-copy.mjs';const a=JSON.parse(process.env.RECOVERY_OBJECT_SYNTHETIC_FIXTURE);const source=await openRecoveryObjectLocalStorage({directory:a.source}),destination=await openRecoveryObjectLocalStorage({directory:a.destination}),journal=await openRecoveryObjectLocalJournal({directory:a.journal});const plan=await prepareRecoveryObjectCopy({image:{...a.image,storage:source,masterKey:Buffer.alloc(32,17)},sourceStorage:source,resolveArchiveKey:async()=>Buffer.alloc(32,29)});await copyRecoveryObjects({plan,destinationStorage:destination,journal:{load:k=>journal.load(k),async compareAndSwap(k,p,n){await journal.compareAndSwap(k,p,n);if(n.nextObject===1)process.kill(process.pid,'SIGKILL');}}});`;
 const {storage,masterKey,...image}=f.imageOptions,result=spawnSync(process.execPath,['--input-type=module','-e',child],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH,RECOVERY_OBJECT_SYNTHETIC_FIXTURE:JSON.stringify({source:f.sourceStorage.directory,destination:f.destination.directory,journal:f.journal.directory,image})},encoding:'utf8',timeout:30000});
 assert.equal(result.signal,'SIGKILL',result.stderr);const reopened=await openRecoveryObjectLocalJournal({directory:f.journal.directory});t.after(()=>reopened.close());const plan=await f.prepare();assert.equal((await reopened.load(plan.copyPlanSha256)).nextObject,1);const resumed=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:reopened});assert.equal(resumed.complete,true);assert.equal(resumed.objectsCopiedThisInvocation,plan.objectCount-1);
});

test('uncertain put followed by restart reuses exact immutable bytes and only journals verified readback',async t=>{
 const f=await fixture(t),plan=await f.prepare();let first=true;const uncertain={read:(...args)=>f.destination.read(...args),async putImmutable(...args){await f.destination.putImmutable(...args);if(first){first=false;throw Error('synthetic-put-interruption');}}};
 await assert.rejects(copyRecoveryObjects({plan,destinationStorage:uncertain,journal:f.journal}),/synthetic-put-interruption/);assert.equal((await f.journal.load(plan.copyPlanSha256)).nextObject,0);
 const resumed=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal});assert.equal(resumed.complete,true);
});

test('a timed out put may finish immutable publication later but cannot advance the journal or reuse a mutable buffer',async t=>{
 const f=await fixture(t),plan=await f.prepare({limits:{requestMs:1000}});let first=true,finished;
 const delayed={read:(...args)=>f.destination.read(...args),async putImmutable(key,bytes){if(first){first=false;finished=(async()=>{await new Promise(resolve=>setTimeout(resolve,1200));await f.destination.putImmutable(key,bytes);})();await finished;}else await f.destination.putImmutable(key,bytes);}};
 await assert.rejects(copyRecoveryObjects({plan,destinationStorage:delayed,journal:f.journal}),/deadline/);assert.equal((await f.journal.load(plan.copyPlanSha256)).nextObject,0);
 await assert.rejects(copyRecoveryObjects({plan,destinationStorage:delayed,journal:f.journal}),/still-in-flight/);await finished;await new Promise(resolve=>setImmediate(resolve));
 const result=await copyRecoveryObjects({plan,destinationStorage:delayed,journal:f.journal});assert.equal(result.complete,true);
});

test('destination tamper, missing prefix, or wrong journal cannot resume as verified',async t=>{
 for(const mode of ['tamper','missing','journal']){const f=await fixture(t),plan=await f.prepare();await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal,maxObjectsPerInvocation:1});const progress=await f.journal.load(plan.copyPlanSha256),first=[...f.objects].sort((a,b)=>a.key<b.key?-1:1)[0];
  if(mode==='tamper')await writeFile(file(f.destination,first.key),Buffer.alloc(first.bytes,0),{mode:0o600});else if(mode==='missing')await unlink(file(f.destination,first.key));else await f.journal.compareAndSwap(plan.copyPlanSha256,progress,{...progress,copyPlanSha256:'0'.repeat(64)});
  await assert.rejects(copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal}),/integrity|ENOENT|journal-conflict/);
 }
});

test('missing/corrupt source copies and immutable destination collisions never publish verified state',async t=>{
 for(const mode of ['missing','corrupt','collision']){const f=await fixture(t),plan=await f.prepare(),leaf=f.objects.find(item=>item.key.includes('/chunks/'));
  if(mode==='missing')await unlink(file(f.sourceStorage,leaf.key));else if(mode==='corrupt')await writeFile(file(f.sourceStorage,leaf.key),Buffer.alloc(leaf.bytes,0),{mode:0o600});else await writeFile(file(f.destination,leaf.key),Buffer.alloc(leaf.bytes,0),{flag:'wx',mode:0o600});
  await assert.rejects(copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal}),/ENOENT|integrity|immutable-conflict/);assert.notEqual((await f.journal.load(plan.copyPlanSha256)).state,'verified_quarantine');
 }
});

test('authenticated closure cannot omit actual archive manifest children or invent leaf dependencies',async t=>{
 const omitted=await fixture(t,{mutateInventory:objects=>{objects.find(item=>item.key.includes('/archives/')||item.key.startsWith('archives/')&&item.key.includes('/manifests/')).children=[];objects.splice(1,objects.filter(item=>item.key.includes('/chunks/')).length);}});
 await assert.rejects(omitted.prepare(),/manifest-closure-mismatch/);
 const leaf=await fixture(t,{mutateInventory:objects=>{const chunk=objects.find(item=>item.key.includes('/chunks/'));chunk.children=[{key:objects[0].key,sha256:objects[0].sha256}];}});await assert.rejects(leaf.prepare(),/cycle/);
});

test('cross-tenant paths, URLs, conflicting hashes, duplicate or unreferenced objects fail closed',async t=>{
 for(const mode of ['tenant','url','hash','duplicate','extra']){
  await assert.rejects(async()=>{const f=await fixture(t,{mutateInventory:objects=>{const leaf=objects.find(item=>item.key.includes('/chunks/'));if(mode==='tenant')leaf.key=leaf.key.replace('/'+tenantId+'/', '/other_tenant/');if(mode==='url')leaf.key='https://example.test/'+leaf.sha256;if(mode==='hash')leaf.sha256='0'.repeat(64);if(mode==='duplicate')objects.push(structuredClone(leaf));if(mode==='extra')objects.push({...leaf,key:leaf.key.replace('/original_run/','/unreferenced_run/')});}});await f.prepare();},/key-scope|content-address|duplicate-object|unreferenced-object/);
 }
});

test('image or artifact authentication and original archive key are mandatory',async t=>{
 const f=await fixture(t);await assert.rejects(f.prepare({image:{...f.imageOptions,masterKey:Buffer.alloc(32)}}),/authentication/);await assert.rejects(f.prepare({resolveArchiveKey:async()=>Buffer.alloc(32)}),/manifest-authentication/);
 await writeFile(file(f.sourceStorage,f.artifacts.objectClosure.key),Buffer.from('{}'),{mode:0o600});await assert.rejects(f.prepare(),/integrity/);
});

test('deep and dense authenticated external metadata is rejected before materializing a JSON graph',async t=>{
 for(const value of ['['.repeat(1000)+'0'+']'.repeat(1000),'['+'0,'.repeat(600_000)+'0]']){
  const f=await fixture(t,{mutateArtifacts:artifacts=>{artifacts.closure=Buffer.from(value);const sha256=hash(artifacts.closure);artifacts.objectClosure.sha256=sha256;artifacts.objectClosure.key=`recovery-objects/v1/${tenantId}/closures/${sha256}`;}});
  await assert.rejects(f.prepare(),/preparse-limit/);
 }
});

test('object count/size/total/I/O/request/deadline budgets fail without raising limits',async t=>{
 const f=await fixture(t);
 for(const limits of [{objects:1},{objectBytes:10},{totalBytes:10},{ioBytes:10},{requests:1},{metadataBytes:10}])await assert.rejects(f.prepare({limits}),/limit|argument|integrity|size|read-limit/);
 await assert.rejects(f.prepare({limits:{objectBytes:RECOVERY_OBJECT_LIMITS.objectBytes+1}}),/argument/);
 let clock=0;await assert.rejects(f.prepare({limits:{runtimeMs:1000},monotonicNow:()=>clock+=600}),/deadline/);
 await assert.rejects(f.prepare({monotonicNow:()=>NaN}),/clock/);
});

test('copy request and I/O exhaustion leave durable progress disabled and incomplete',async t=>{
 for(const kind of ['requests','ioBytes']){
  const f=await fixture(t);let reads=0,bytes=0;const source={async read(key,options){reads++;const value=await f.sourceStorage.read(key,options);bytes+=value.length;return value;}};
  const options={sourceStorage:source,image:{...f.imageOptions,storage:source}};await f.prepare(options);
  const allowance=kind==='requests'?reads+2:bytes+1024,plan=await f.prepare({...options,limits:{[kind]:allowance}});
  await assert.rejects(copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal}),/request-limit|io-limit/);const progress=await f.journal.load(plan.copyPlanSha256);assert.equal(progress.state,'copying');assert.equal(progress.activationAllowed,false);assert.ok(progress.nextObject<plan.objectCount);
 }
});

test('all storage I/O remains sequential and each requested buffer has an explicit bound',async t=>{
 const f=await fixture(t);let active=0,peak=0;const caps=[];const tracked={async read(key,{maxBytes}){active++;peak=Math.max(peak,active);caps.push(maxBytes);try{await new Promise(resolve=>setImmediate(resolve));return await f.sourceStorage.read(key,{maxBytes});}finally{active--;}}};
 const plan=await f.prepare({sourceStorage:tracked,image:{...f.imageOptions,storage:tracked}});await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal});assert.equal(peak,1);assert.ok(caps.every(value=>value>0&&value<=RECOVERY_OBJECT_LIMITS.metadataBytes));
});

test('large snapshot closure copies 10240 records across256 bounded pages without buffering the full payload',async t=>{
 const f=await fixture(t,{snapshotPageCount:256});let active=0,peak=0,maxDataRead=0;const before=process.memoryUsage().rss;let maxRss=before;
 const source={async read(key,options){active++;peak=Math.max(peak,active);try{const result=await f.sourceStorage.read(key,options);if(key.startsWith('snapshots/'))maxDataRead=Math.max(maxDataRead,result.length);maxRss=Math.max(maxRss,process.memoryUsage().rss);return result;}finally{active--;}}};
 const plan=await f.prepare({sourceStorage:source,image:{...f.imageOptions,storage:source},limits:{objects:1000}});assert.ok(plan.totalBytes>12_000_000);
 const copied=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal});assert.equal(copied.complete,true);assert.equal(peak,1);assert.ok(maxDataRead<100_000);assert.ok(maxRss-before<96*1024*1024,'bounded incremental RSS, separate from provider acceptance');
 const independent=await verifyRecoveryObjectDestination({plan,destinationStorage:f.destination});assert.equal(independent.byteIntegrityVerified,true);
});

test('authenticated metadata above1MiB is copied under its separate8MiB cap while ordinary objects retain1MiB cap',async t=>{
 const f=await fixture(t,{snapshotPageCount:3200,snapshotRecordsPerPage:1});assert.ok(f.artifacts.closure.length>1_048_576);assert.ok(f.artifacts.closure.length<RECOVERY_OBJECT_LIMITS.metadataBytes);
 const plan=await f.prepare(),prefix=f.objects.filter(item=>item.key.startsWith('archives/')).length+2;
 const partial=await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal,maxObjectsPerInvocation:prefix});assert.equal(partial.complete,false);
 assert.deepEqual(await f.destination.read(f.artifacts.objectClosure.key,{maxBytes:f.artifacts.closure.length}),f.artifacts.closure);
 assert.equal((await copyRecoveryObjects({plan,destinationStorage:f.destination,journal:f.journal})).complete,true);
});

test('local adapter rejects paths/symlinks/oversize and never exposes a partial final object',async t=>{
 const f=await fixture(t),bytes=Buffer.from('immutable synthetic bytes'),key=`snapshots/v1/${tenantId}/isolated/pages/${hash(bytes)}`;
 const writing=f.destination.putImmutable(key,bytes);bytes.fill(0);await writing;assert.equal((await f.destination.read(key,{maxBytes:100})).toString(),'immutable synthetic bytes');
 await assert.rejects(f.destination.putImmutable('../outside',Buffer.alloc(1)),/key/);await assert.rejects(f.destination.putImmutable(key,Buffer.alloc(RECOVERY_OBJECT_LIMITS.metadataBytes+1)),/content-address/);
 const original=await readFile(file(f.destination,key));await unlink(file(f.destination,key));await symlink(file(f.sourceStorage,f.exported.manifestKey),file(f.destination,key));await assert.rejects(f.destination.read(key,{maxBytes:100}),/ELOOP/);await unlink(file(f.destination,key));await writeFile(file(f.destination,key),original,{mode:0o600});
 assert.deepEqual((await readdir(f.destination.directory)).filter(name=>name.endsWith('.unpublished')),[]);
});

test('an inode growing after stat cannot make the local reader allocate or read beyond its byte cap',async t=>{
 const f=await fixture(t),body=Buffer.from('bounded'),key=`snapshots/v1/${tenantId}/growing/pages/${hash(body)}`;await f.destination.putImmutable(key,body);const path=file(f.destination,key),handle=await open(path,'r');let first=true,largestRequest=0;
 try{await assert.rejects(readRecoveryObjectHandleBounded({stat:()=>handle.stat(),async read(buffer,offset,length,position){largestRequest=Math.max(largestRequest,length);if(first){first=false;await appendFile(path,Buffer.alloc(1_048_576,1));}return handle.read(buffer,offset,length,position);}},16),/read-limit/);assert.equal(largestRequest,body.length+1);assert.ok(largestRequest<=17);}finally{await handle.close();}
});
