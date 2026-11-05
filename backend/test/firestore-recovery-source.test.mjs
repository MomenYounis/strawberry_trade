import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,createHmac,hkdfSync,randomBytes} from 'node:crypto';
import {canonical} from '../src/validation.mjs';
import {createFirestoreRecoverySource,decodeRecoveryFields,isFirestoreRecoveryProof} from '../src/firestore-recovery-source.mjs';
import {exportFirestoreRecoveryImage,verifyFirestoreRecoveryImage} from '../src/firestore-recovery-image.mjs';
import {createRecoveryDependencyCollector,buildRecoveryDependencyPlan} from '../src/recovery-dependency-plan.mjs';
import {exportSyntheticTenantRecoveryImage} from '../src/tenant-recovery-quarantine.mjs';
const projectId='demo-recovery-fixture',databaseId='(default)',tenantId='tenant_a',readTime='2026-11-05T09:00:00.000000Z',nowMs=Date.parse(readTime)+60_000;
const prefix=`projects/${projectId}/databases/${databaseId}/documents`,root=prefix+'/tenants/'+tenantId;
const old='2026-11-05T08:00:00Z',changed='2026-11-05T08:59:00Z';
const hash=value=>createHash('sha256').update(value).digest('hex');
function typed(value){if(value===null)return {nullValue:null};if(typeof value==='string')return {stringValue:value};if(typeof value==='number')return {integerValue:String(value)};if(typeof value==='boolean')return {booleanValue:value};if(Array.isArray(value))return {arrayValue:{values:value.map(typed)}};return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typed(v)]))}};}
function document(path,payload){return {name:path,createTime:old,updateTime:changed,fields:Object.fromEntries(Object.entries(payload).map(([k,v])=>[k,typed(v)]))};}
const baseRows=()=>({[root]:document(root,{enabled:true,ownerUid:'manager_1',sequence:2}),
 [root+'/entries/a']:document(root+'/entries/a',{tenantId,totalMinor:7000,creatorUid:'manager_1'}),
 [root+'/entries/b']:document(root+'/entries/b',{tenantId,totalMinor:3000,creatorUid:'employee_1'}),
 [root+'/members/manager_1']:document(root+'/members/manager_1',{role:'manager',active:true})});
async function service(t,{rows=baseRows(),override}={}){
 const requests=[];let liveChanges=0;
 const server=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const url=new URL(req.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname.slice(4)),json=body?JSON.parse(body):null;
  const event={method:req.method,path,query:Object.fromEntries(url.searchParams),body:json,authorization:req.headers.authorization};requests.push(event);liveChanges++;
  let result;
  if(override){const answer=await override(event,{requests,rows,liveChanges});if(answer!==undefined){if(answer.raw!==undefined){res.writeHead(answer.status??200,{'content-type':'application/json'});res.end(answer.raw);return;}result=answer;}}
  if(result===undefined){
   if(path.endsWith(':listCollectionIds')){const parent=path.slice(0,-18),ids=[...new Set(Object.keys(rows).filter(name=>name.startsWith(parent+'/')).map(name=>name.slice(parent.length+1).split('/')).filter(parts=>parts.length>=2).map(parts=>parts[0]))].sort();const offset=Number(json.pageToken??0),count=json.pageSize;result={collectionIds:ids.slice(offset,offset+count),...(offset+count<ids.length?{nextPageToken:String(offset+count)}:{})};}
   else if(rows[path])result=rows[path];
   else{const docs=Object.keys(rows).filter(name=>name.startsWith(path+'/')&&name.slice(path.length+1).split('/').length===1).sort().map(name=>rows[name]);const offset=Number(url.searchParams.get('pageToken')??0),count=Number(url.searchParams.get('pageSize'));result={documents:docs.slice(offset,offset+count),...(offset+count<docs.length?{nextPageToken:String(offset+count)}:{})};}
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 return {requests,source:options=>createFirestoreRecoverySource({projectId,databaseId,tenantId,readTime,accessToken:async()=>'synthetic-token',endpoint,allowLoopbackForTests:true,now:()=>nowMs,...options})};
}
async function collect(source){const rows=[];const proof=await source.capture({writeRecord:row=>rows.push(row)});return {rows,proof};}
function memoryStorage(){const objects=new Map();return {objects,async putImmutable(key,value){const next=Buffer.from(value),prior=objects.get(key);if(prior&&!prior.equals(next))throw Error('conflict');objects.set(key,next);},async read(key,{maxBytes}){const value=objects.get(key);if(!value)throw Error('missing');if(value.length>maxBytes)throw Error('size');return Buffer.from(value);}};}

test('all root, paged document and orphan inventory reads use one fixed timestamp and remain read-only',async t=>{
 const fixture=await service(t);const {rows,proof}=await collect(fixture.source());assert.equal(rows.length,4);assert.equal(rows.filter(row=>row.collection==='entries').reduce((n,row)=>n+row.payload.totalMinor,0),10_000);
 assert.equal(isFirestoreRecoveryProof(proof),true);assert.equal(proof.productionSourceConsistencyAccepted,false);assert.equal(proof.localTransportFixture,true);assert.equal(proof.rootUpdateTime,changed);assert.ok(Object.isFrozen(rows[0].payload));
 for(const call of fixture.requests){assert.equal(call.authorization,'Bearer synthetic-token');if(call.method==='POST'){assert.ok(call.path.endsWith(':listCollectionIds'));assert.equal(call.body.readTime,readTime);}else{assert.equal(call.method,'GET');assert.equal(call.query.readTime,readTime);if(call.query.pageSize){assert.equal(call.query.showMissing,'true');assert.equal(call.query.orderBy,undefined);}}}
 assert.ok(fixture.requests.some(call=>call.query.pageToken==='1'));
});

test('strict typed decoder preserves safe JSON and rejects lossy, reserved and unsupported values',()=>{
 assert.deepEqual(decodeRecoveryFields({zero:{integerValue:'0'},negative:{integerValue:'-9007199254740991'},list:typed([true,null,'العربية',{n:42}])}),{zero:0,negative:-9007199254740991,list:[true,null,'العربية',{n:42}]});
 for(const value of [{integerValue:'9007199254740992'},{integerValue:'1.0'},{integerValue:'-0'},{doubleValue:1},{timestampValue:old},{bytesValue:'AA=='},{referenceValue:root},{geoPointValue:{latitude:1,longitude:2}},{integerValue:'1',stringValue:'1'}])assert.throws(()=>decodeRecoveryFields({value}),/firestore-recovery-/);
 assert.throws(()=>decodeRecoveryFields(JSON.parse('{"__proto__":{"stringValue":"bad"}}')),/field-name/);
 assert.throws(()=>decodeRecoveryFields({a:typed([1,2,3])},{maxNodes:2}),/field-limit/);
});

test('expired/future or overprecision timestamps reject before token access or network',()=>{
 let tokens=0;const base={projectId,databaseId,tenantId,readTime,accessToken:async()=>{tokens++;return 'x';},now:()=>nowMs};
 for(const value of ['2026-11-05T07:00:00Z','2026-11-05T09:02:00Z','2026-11-05T09:00:00.0000001Z','2026-02-30T00:00:00Z'])assert.throws(()=>createFirestoreRecoverySource({...base,readTime:value}),/firestore-recovery-/);
 assert.equal(tokens,0);
});

test('explicit project-matched PITR permits only whole-minute old reads and no live fallback',async t=>{
 const fixture=await service(t);const pitrCapability={projectId,databaseId,enabled:true,earliestVersionTime:'2026-11-01T00:00:00Z',verifiedAtMs:nowMs};
 const source=fixture.source({readTime:'2026-11-04T09:00:00Z',pitrCapability});
 // Fixture source timestamps are after the requested historical snapshot: reject.
 await assert.rejects(collect(source),/document-time/);assert.equal(fixture.requests.length,1);assert.equal(fixture.requests[0].query.readTime,'2026-11-04T09:00:00Z');
 assert.throws(()=>fixture.source({readTime:'2026-11-04T09:00:01Z',pitrCapability}),/read-time-expired/);
 assert.throws(()=>fixture.source({readTime:'2026-11-04T09:00:00Z',pitrCapability:{...pitrCapability,projectId:'other-project'}}),/pitr-capability/);
});

test('expiry during capture stops without querying live state',async t=>{
 let current=nowMs;const fixture=await service(t);const source=fixture.source({now:()=>current});await assert.rejects(source.capture({writeRecord(){current+=3_600_000;}}),/read-time-expired/);
 assert.equal(fixture.requests.length,2);assert.ok(fixture.requests.every(call=>(call.body?.readTime??call.query.readTime)===readTime));
});

test('provider consistency rejection is terminal and is never retried without readTime',async t=>{
 const fixture=await service(t,{override:()=>({status:400,raw:'{"error":{"message":"expired snapshot"}}'})});await assert.rejects(collect(fixture.source()),/provider-consistency-rejected/);assert.equal(fixture.requests.length,1);
});

test('fixed timestamp root drift and future update metadata fail closed',async t=>{
 const fixture=await service(t,{override:(call,{rows,requests})=>call.path===root&&requests.filter(r=>r.path===root).length===2?{...rows[root],fields:{enabled:typed(false)}}:undefined});await assert.rejects(collect(fixture.source()),/fixed-time-drift/);
 const rows=baseRows();rows[root].updateTime='2026-11-05T09:00:00.000001Z';const future=await service(t,{rows});await assert.rejects(collect(future.source()),/document-time/);
});

test('unknown, nested and missing-parent documents cannot disappear from capture',async t=>{
 for(const mode of ['unknown','nested','orphan']){
  const rows=baseRows();if(mode==='unknown')rows[root+'/secretDocs/a']=document(root+'/secretDocs/a',{});
  if(mode==='nested')rows[root+'/entries/a/nested/child']=document(root+'/entries/a/nested/child',{});
  if(mode==='orphan'){rows[root+'/entries/a']={name:root+'/entries/a'};rows[root+'/entries/a/nested/child']=document(root+'/entries/a/nested/child',{});}
  const fixture=await service(t,{rows});await assert.rejects(collect(fixture.source()),new RegExp(mode==='unknown'?'unknown-collection':mode==='nested'?'nested-collection':'orphan-document'));
 }
});

test('record, total data, response, global wire and request bounds stop capture',async t=>{
 for(const [limits,error]of [[{records:1},'source-limit'],[{totalBytes:10},'source-limit'],[{recordBytes:10},'record-limit'],[{responseBytes:32},'response-limit'],[{wireBytes:32},'wire-limit'],[{requests:1},'request-limit']]){
  const fixture=await service(t);await assert.rejects(collect(fixture.source({limits})),new RegExp(error));
 }
 const whitespace=await service(t,{override:()=>({raw:' '.repeat(8192)+'{}'})});await assert.rejects(collect(whitespace.source({limits:{wireBytes:1024}})),/wire-limit/);
});

test('request timeout and capture deadline bound a stalled response/consumer',async t=>{
 const slow=await service(t,{override:async()=>{await new Promise(resolve=>setTimeout(resolve,100));return undefined;}});await assert.rejects(collect(slow.source({limits:{requestTimeoutMs:10}})),/timeout|aborted/i);
 // Isolate consumer expiry from HTTP scheduling. Under the full parallel suite
 // a 20ms wall-clock budget can expire before the local server responds.
 let clock=0;const fixture=await service(t);let consumed=false;
 await assert.rejects(fixture.source({monotonicNow:()=>clock,limits:{durationMs:10_000}}).capture({writeRecord(){consumed=true;clock+=10_001;}}),/capture-deadline/);
 assert.equal(consumed,true);
});

test('duplicate/out-of-order names, foreign tenant paths and continuation loops reject',async t=>{
 for(const mode of ['duplicate','foreign','token']){
  const fixture=await service(t,{override:call=>{
   if(call.path!==root+'/entries')return undefined;
   if(mode==='foreign')return {documents:[document(root+'/entries/a/foreign',{})]};
   if(mode==='duplicate')return {documents:[document(root+'/entries/a',{})],nextPageToken:'again'};
   return {documents:[],nextPageToken:'again'};
  }});await assert.rejects(collect(fixture.source()),/document-order|invalid-argument|empty-continuation-page/);
 }
});

test('endpoint routing rejects ADC-style omission, credential URLs and nonprovider HTTP',()=>{
 const base={projectId,databaseId,tenantId,readTime,accessToken:async()=>'token',now:()=>nowMs};
 for(const endpoint of ['https://evil.test','http://firestore.googleapis.com','https://token@firestore.googleapis.com','https://firestore.googleapis.com/path','http://127.0.0.1:12345'])assert.throws(()=>createFirestoreRecoverySource({...base,endpoint}),/endpoint/);
 assert.throws(()=>createFirestoreRecoverySource({...base,accessToken:undefined}),/explicit-token/);
});

test('encrypted fixed-time image round-trips with source metadata, precise dependencies and activation OFF',async t=>{
 const fixture=await service(t),source=fixture.source(),storage=memoryStorage(),masterKey=randomBytes(32),imageId='capture_a',keyId='recovery_key';
 const result=await exportFirestoreRecoveryImage({source,storage,masterKey,imageId,keyId,createdAtMs:nowMs});
 assert.equal(result.recordCount,4);assert.equal(result.activationAllowed,false);assert.deepEqual(result.dependencyPlan.required.authUids,['employee_1','manager_1']);assert.deepEqual(result.dependencyPlan.required.keyIds,['recovery_key']);assert.equal(result.dependencyPlan.inventoryComplete,false);
 const expected={projectId,databaseId,tenantId,readTime,imageId,keyId},seen=[];const checked=await verifyFirestoreRecoveryImage({storage,masterKey,...result,expected,onRecord:row=>seen.push(row)});assert.equal(checked.recordCount,4);assert.equal(seen[1].source.updateTime,changed);
 assert.ok([...storage.objects.values()].every(value=>!value.includes(Buffer.from('totalMinor'))));
 await assert.rejects(verifyFirestoreRecoveryImage({storage,masterKey:randomBytes(32),...result,expected}),/authentication/);
 await assert.rejects(verifyFirestoreRecoveryImage({storage,masterKey,...result,expected:{...expected,tenantId:'tenant_b'}}),/expected-context/);
 await assert.rejects(exportSyntheticTenantRecoveryImage({source,storage,masterKey,context:{tenantId,imageId,sourceProjectId:'demo-strawberry-flutter',keyId,createdAtMs:nowMs}}),/accepted-recovery-source/);
});

test('interrupted, expired or invalid capture never publishes a manifest; source cannot be forged',async t=>{
 const fixture=await service(t),storage=memoryStorage(),masterKey=randomBytes(32);let writes=0;
 await assert.rejects(exportFirestoreRecoveryImage({source:fixture.source(),storage:{async putImmutable(key,value){writes++;throw Error('storage-interrupted');}},masterKey,imageId:'capture_a',keyId:'key_a',createdAtMs:nowMs}),/storage-interrupted/);assert.equal(writes,1);assert.equal(storage.objects.size,0);
 await assert.rejects(exportFirestoreRecoveryImage({source:{context:fixture.source().context,capture:async()=>{}},storage,masterKey,imageId:'a',keyId:'k',createdAtMs:nowMs}),/branded-source/);
});

test('ciphertext damage and a missing page reject verification without activation',async t=>{
 const fixture=await service(t),storage=memoryStorage(),masterKey=randomBytes(32),imageId='capture_a',keyId='key_a';const result=await exportFirestoreRecoveryImage({source:fixture.source(),storage,masterKey,imageId,keyId,createdAtMs:nowMs});const expected={projectId,databaseId,tenantId,readTime,imageId,keyId};
 const page=[...storage.objects.keys()].find(key=>key.includes('/pages/')),original=Buffer.from(storage.objects.get(page));storage.objects.get(page)[20]^=1;
 await assert.rejects(verifyFirestoreRecoveryImage({storage,masterKey,...result,expected}),/page-integrity/);storage.objects.set(page,original);storage.objects.delete(page);await assert.rejects(verifyFirestoreRecoveryImage({storage,masterKey,...result,expected}),/missing/);
});

test('dependency graph pins Auth identities, operator history, snapshot roots, archive children and key IDs',async t=>{
 const rows=baseRows(),manifestHash='a'.repeat(64),pageHash='b'.repeat(64),snapshotHash='c'.repeat(64);
 rows[root+'/archiveRuns/2026']=document(root+'/archiveRuns/2026',{manifest:{key:'archives/v1/a/manifests/'+manifestHash,sha256:manifestHash},keyId:'archive_key'});
 const fixture=await service(t,{rows}),collector=createRecoveryDependencyCollector(),proof=await fixture.source().capture({writeRecord:row=>collector.observe(row)}),required=collector.finish({sourceProof:proof,imageKeyId:'image_key'});
 const common={projectId,databaseId,tenantId,readTime,key:'private/artifact',sha256:'d'.repeat(64)},rootObject=required.objectRoots[0];
 const evidence={authExport:{...common,uids:['manager_1','employee_1']},operatorHistory:{...common},snapshotCatalog:{...common,objectRoots:[{key:'snapshots/page',sha256:snapshotHash}]},objectClosure:{...common,objects:[{...rootObject,keyIds:['archive_key'],children:[{key:'archives/page',sha256:pageHash}]},{key:'archives/page',sha256:pageHash,children:[],keyIds:['archive_key']},{key:'snapshots/page',sha256:snapshotHash,children:[],keyIds:[]}]},keyCustody:{...common,keyIds:['archive_key','image_key']}};
 const plan=buildRecoveryDependencyPlan({required,evidence});assert.equal(plan.inventoryComplete,true);assert.equal(plan.activationAllowed,false);assert.ok(plan.activationBlockers.includes('fresh-auth-device-and-license-enrollment-required'));
 const missing=structuredClone(evidence);missing.objectClosure.objects.pop();missing.authExport.uids.pop();missing.keyCustody.keyIds=[];const incomplete=buildRecoveryDependencyPlan({required,evidence:missing});assert.ok(incomplete.missing.includes('auth-users-missing'));assert.ok(incomplete.missing.includes('key-ids-missing'));assert.ok(incomplete.missing.some(item=>item.startsWith('object-missing-or-hash-mismatch:')));
 assert.throws(()=>buildRecoveryDependencyPlan({required,evidence:{...evidence,operatorHistory:{...common,tenantId:'tenant_b'}}}),/context/);
 assert.throws(()=>buildRecoveryDependencyPlan({required:structuredClone(required),evidence}),/captured-requirements/);
});

test('dependency collector refuses rows omitted from the branded captured stream',async t=>{
 const fixture=await service(t),collector=createRecoveryDependencyCollector(),{proof}=await collect(fixture.source());assert.throws(()=>collector.finish({sourceProof:proof,imageKeyId:'key_a'}),/source-stream-mismatch/);
});

test('incomplete object references and malformed authority identities refuse capture',async t=>{
 for(const payload of [{manifestKey:'missing/hash'},{manifestSha256:'a'.repeat(64)},{ownerUid:123},{keyId:123}]){
  const rows=baseRows();rows[root+'/archiveRuns/2026']=document(root+'/archiveRuns/2026',payload);
  const fixture=await service(t,{rows}),storage=memoryStorage();
  await assert.rejects(exportFirestoreRecoveryImage({source:fixture.source(),storage,masterKey:randomBytes(32),imageId:'invalid',keyId:'key_a',createdAtMs:nowMs}),/recovery-dependency-/);
  assert.ok([...storage.objects.keys()].every(key=>!key.includes('/manifests/')));
 }
});

test('authenticated dependency metadata must match the decrypted authority stream',async t=>{
 const fixture=await service(t),storage=memoryStorage(),masterKey=randomBytes(32),imageId='capture_a',keyId='key_a';
 const result=await exportFirestoreRecoveryImage({source:fixture.source(),storage,masterKey,imageId,keyId,createdAtMs:nowMs});
 const original=JSON.parse(storage.objects.get(result.manifestKey).toString());
 async function changedManifest(change){
  const envelope=structuredClone(original);change(envelope.body.dependencyPlan);
  const key=Buffer.from(hkdfSync('sha256',masterKey,Buffer.from(canonical(envelope.body.context)),Buffer.from('strawberry-firestore-recovery-v1/manifest'),32));
  try{envelope.mac=createHmac('sha256',key).update(canonical(envelope.body)).digest('hex');}finally{key.fill(0);}
  const raw=Buffer.from(canonical(envelope)),manifestSha256=hash(raw),manifestKey=result.manifestKey.replace(/[a-f0-9]{64}$/,manifestSha256);storage.objects.set(manifestKey,raw);
  return verifyFirestoreRecoveryImage({storage,masterKey,manifestKey,manifestSha256,expected:{projectId,databaseId,tenantId,readTime,imageId,keyId}});
 }
 await assert.rejects(changedManifest(plan=>{plan.required.authUids=[];plan.requirementsSha256=hash(canonical(plan.required));}),/plan-stream-mismatch/);
 await assert.rejects(changedManifest(plan=>{plan.inventoryComplete=true;}),/plan-gates|plan-incomplete/);
 await assert.rejects(changedManifest(plan=>{plan.source.tenantId='tenant_b';}),/plan-stream-mismatch/);
 await assert.rejects(changedManifest(plan=>{plan.unreviewed=true;}),/plan-schema/);
});
