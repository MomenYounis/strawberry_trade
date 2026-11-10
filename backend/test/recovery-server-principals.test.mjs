import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,createHmac,hkdfSync,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {canonical} from '../src/validation.mjs';
import {provisionTenant} from '../src/enrollment.mjs';
import {transferDemoDevice} from '../src/demo-device-transfer.mjs';
import {createEnrollmentPlan} from '../../tools/production-operator/plan.mjs';
import {createAdminOperations,ADMIN_PROJECT_ID} from '../../tools/admin-panel/operations.mjs';
import {createFirestoreRecoverySource} from '../src/firestore-recovery-source.mjs';
import {exportFirestoreRecoveryImage,verifyFirestoreRecoveryImage} from '../src/firestore-recovery-image.mjs';
import {createRecoveryDependencyCollector} from '../src/recovery-dependency-plan.mjs';
import {captureRecoveryAuthorityPackage,authorityDigest} from '../src/recovery-authority-package.mjs';
import {prepareImageBoundRecoveryAuthority,disposeImageBoundRecoveryAuthority} from '../src/recovery-authority-binding.mjs';
const tenantId='principal_business',owner='manager_real',employee='employee_real',projectId='demo-principal-recovery',databaseId='(default)',readTime='2026-11-07T10:00:00.000000Z',now=Date.parse(readTime),atMs=now-60_000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),json=value=>Buffer.from(JSON.stringify(value));
function device(){const bytes=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'});return {deviceId:createHash('sha256').update(bytes).digest('base64url'),publicKeySpki:bytes.toString('base64url')};}
function localDb(project=ADMIN_PROJECT_ID){
 const docs=new Map();
 class Ref{constructor(path){this.path=path;this.id=path.split('/').at(-1);}collection(name){return new Query(this.path+'/'+name);}}
 class Query{constructor(path,filters=[]){this.path=path;this.filters=filters;}doc(name){return new Ref(this.path+'/'+name);}where(key,op,value){assert.equal(op,'==');return new Query(this.path,[...this.filters,[key,value]]);}}
 const snap=ref=>({ref,id:ref.id,exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path)),readTime:{toMillis:()=>atMs}});
 const db={projectId:project,databaseId,doc:path=>new Ref(path),collection:path=>new Query(path),async runTransaction(action){const changes=[];const tx={async get(ref){if(ref instanceof Query)return {docs:[...docs.keys()].filter(path=>path.startsWith(ref.path+'/')&&path.split('/').length===ref.path.split('/').length+1&&ref.filters.every(([key,value])=>docs.get(path)[key]===value)).map(path=>snap(new Ref(path))),readTime:{toMillis:()=>atMs}};return snap(ref);},create(ref,payload){if(docs.has(ref.path))throw Error('existing');changes.push([ref.path,structuredClone(payload)]);},set(ref,payload){changes.push([ref.path,structuredClone(payload)]);},update(ref,payload){if(!docs.has(ref.path))throw Error('missing');changes.push([ref.path,{...docs.get(ref.path),...structuredClone(payload)}]);}};const result=await action(tx);for(const [path,payload]of changes)docs.set(path,payload);return result;}};
 return {db,docs};
}
async function producerRows(){
 const f=localDb(),first=device(),next=device(),auth={app:{options:{projectId:ADMIN_PROJECT_ID}},async getUser(uid){return {uid,email:uid+'@example.invalid',emailVerified:true,disabled:false};},async revokeRefreshTokens(){}};
 await provisionTenant({db:f.db,auth,tenantId,uid:owner,name:'Real producer fixture',...first,maxDevices:2,now:atMs});
 const provision=structuredClone(f.docs.get('tenants/'+tenantId+'/audit/tenant_created'));
 const request={projectId:'strawberry-principal-fixture',databaseId,tenantId,ownerUid:owner,expectedEmail:owner+'@example.invalid',managerName:'Manager fixture',...first,maxDevices:2};
 const plan=createEnrollmentPlan(request,{projectId:request.projectId,databaseId,environment:{}}),production=plan.proposedActions[1].documents.find(row=>row.path.endsWith('/audit/tenant_created')).data;
 assert.deepEqual({...production,atMs},provision,'Actual provisionTenant and production enrollment plan emit the same supported audit shape.');
 const ops=createAdminOperations({db:f.db,auth,now:()=>atMs}),preview=await ops.previewAction({type:'set-tenant-enabled',tenantId,enabled:true});await ops.executeAction({previewId:preview.previewId,confirmation:preview.confirmationText});
 const adminPath='tenants/'+tenantId+'/audit/admin_'+preview.previewId,admin=structuredClone(f.docs.get(adminPath));
 const environment={GCLOUD_PROJECT:'demo-strawberry-flutter',FIRESTORE_EMULATOR_HOST:'127.0.0.1:18180',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19199'};
 await transferDemoDevice({db:f.db,auth,projectId:'demo-strawberry-flutter',environment,request:{tenantId,uid:owner,...next,revokeDeviceId:first.deviceId},now:()=>atMs});
 const transfer=structuredClone(f.docs.get('tenants/'+tenantId+'/audit/transfer_'+next.deviceId));
 f.docs.set('tenants/'+tenantId+'/members/'+employee,{uid:employee,role:'employee',active:true,epoch:1});
 return {docs:f.docs,provision,admin,adminId:'admin_'+preview.previewId,transfer,transferId:'transfer_'+next.deviceId};
}
function typed(value){if(value===null)return {nullValue:null};if(typeof value==='string')return {stringValue:value};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number')return {integerValue:String(value)};if(Array.isArray(value))return {arrayValue:{values:value.map(typed)}};return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([key,child])=>[key,typed(child)]))}};}
async function imageFixture(t,{mutate,includeProducers=true,extraAuthUids=[]}={}){
 const producers=await producerRows(),base='tenants/'+tenantId;
 if(!includeProducers)for(const key of producers.docs.keys())if(key.startsWith(base+'/audit/'))producers.docs.delete(key);
 mutate?.(producers);
 const prefix=`projects/${projectId}/databases/${databaseId}/documents/`,rows=Object.fromEntries([...producers.docs].filter(([path])=>path.startsWith(base)).map(([path,payload])=>{const name=prefix+path;return [name,{name,createTime:new Date(atMs).toISOString(),updateTime:new Date(atMs).toISOString(),fields:Object.fromEntries(Object.entries(payload).map(([key,child])=>[key,typed(child)]))}];}));
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const url=new URL(req.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname.slice(4)),body=raw?JSON.parse(raw):null;assert.equal(body?.readTime??url.searchParams.get('readTime'),readTime);let value;
  if(path.endsWith(':listCollectionIds')){const parent=path.slice(0,-18);value={collectionIds:[...new Set(Object.keys(rows).filter(name=>name.startsWith(parent+'/')).map(name=>name.slice(parent.length+1).split('/')).filter(parts=>parts.length>=2).map(parts=>parts[0]))].sort()};}
  else if(rows[path])value=rows[path];else{const values=Object.keys(rows).filter(name=>name.startsWith(path+'/')&&name.slice(path.length+1).split('/').length===1).sort().map(name=>rows[name]),offset=Number(url.searchParams.get('pageToken')??0),size=Number(url.searchParams.get('pageSize'));value={documents:values.slice(offset,offset+size),...(offset+size<values.length?{nextPageToken:String(offset+size)}:{})};}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const source=createFirestoreRecoverySource({projectId,databaseId,tenantId,readTime,accessToken:async()=>'synthetic-principal-fixture',endpoint:'http://127.0.0.1:'+server.address().port,allowLoopbackForTests:true,now:()=>now}),objects=new Map(),storage={async putImmutable(key,value){const copy=Buffer.from(value);if(objects.has(key)&&!objects.get(key).equals(copy))throw Error('immutable');objects.set(key,copy);},async read(key,{maxBytes}){const value=objects.get(key);if(!value||value.length>maxBytes)throw Error('storage');return Buffer.from(value);}};
 const uids=[employee,owner,...extraAuthUids].sort(),users=uids.map((uid,index)=>({localId:uid,email:'p'+index+'@example.invalid',emailVerified:true,passwordHash:randomBytes(64).toString('base64'),salt:randomBytes(16).toString('base64')})),authRaw=json({users}),operators=json([{path:'adminOperations/'+producers.admin.operationId,payload:{tenantId,type:producers.admin.action,planHash:'a'.repeat(64),result:{status:'applied',tenantId}}}]),common={projectId,databaseId,tenantId,readTime},imageId='principal_image',keyId='original_key',masterKey=randomBytes(32),authorityKey=randomBytes(32);
 const captured=await exportFirestoreRecoveryImage({source,storage,masterKey,imageId,keyId,createdAtMs:now,dependencyEvidence:{authExport:{...common,key:'supplied/auth.json',sha256:authorityDigest(authRaw),uids},operatorHistory:{...common,key:'supplied/operator.json',sha256:authorityDigest(operators)}}});
 const expected={...common,imageId,keyId},image={storage,manifestKey:captured.manifestKey,manifestSha256:captured.manifestSha256,masterKey,expected};
 function authority(manifestSha256=captured.manifestSha256){return captureRecoveryAuthorityPackage({authExportJson:authRaw,operatorRecordsJson:operators,context:{...expected,imageManifestSha256:manifestSha256},requiredUids:uids,masterKey:authorityKey,hash:{algorithm:'SCRYPT',key:Buffer.alloc(64,7).toString('base64'),saltSeparator:'AQ==',rounds:8,memoryCost:14}});}
 return {producers,objects,storage,captured,image,authority,authorityKey,verify:overrides=>verifyFirestoreRecoveryImage({...image,...overrides})};
}
function changedManifest(f,change){const envelope=JSON.parse(f.objects.get(f.image.manifestKey));change(envelope.body.dependencyPlan);const key=Buffer.from(hkdfSync('sha256',f.image.masterKey,Buffer.from(canonical(envelope.body.context)),Buffer.from('strawberry-firestore-recovery-v1/manifest'),32));try{envelope.mac=createHmac('sha256',key).update(canonical(envelope.body)).digest('hex');}finally{key.fill(0);}const raw=Buffer.from(canonical(envelope)),manifestSha256=hash(raw),manifestKey=f.image.manifestKey.slice(0,f.image.manifestKey.lastIndexOf('/')+1)+manifestSha256;f.objects.set(manifestKey,raw);return {manifestKey,manifestSha256};}

test('actual provision/production-plan/admin/transfer audit producers classify service actors without inventing Auth accounts',async t=>{
 const f=await imageFixture(t),required=f.captured.dependencyPlan.required;assert.deepEqual(required.authUids,[employee,owner]);assert.equal(required.serverAuditPrincipalPolicyVersion,1);assert.equal(required.serverAuditPrincipals.length,3);assert.deepEqual(required.serverAuditPrincipals.map(p=>p.kind).sort(),['local-owner-administration','trusted-demo-device-transfer','trusted-tenant-enrollment']);for(const principal of required.serverAuditPrincipals)assert.match(principal.sourceRecordSha256,/^[a-f0-9]{64}$/);
 const checked=await f.verify();assert.deepEqual(checked.dependencyPlan.required,required);const plan=await prepareImageBoundRecoveryAuthority({image:f.image,authorityEnvelope:f.authority(),authorityMasterKey:f.authorityKey});assert.equal(plan.users,2);assert.equal(plan.exactRequiredUidInventoryVerified,true);assert.equal(plan.activationAllowed,false);disposeImageBoundRecoveryAuthority(plan);
});

test('unknown, incomplete or forged audit lookalikes remain Auth dependencies instead of becoming exemptions',async t=>{
 const cases=[
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/audit/not_tenant_created',p.provision);}},
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/entries/tenant_created',p.provision);}},
  {label:'trusted-operator',alter(p){const value={...p.provision};delete value.ownerUid;p.docs.set('tenants/'+tenantId+'/audit/tenant_created',value);}},
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/audit/tenant_created',{...p.provision,creatorUid:owner});}},
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/audit/tenant_created',{...p.provision,atMs:String(atMs)});}},
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/audit/'+p.transferId,{...p.transfer,oldDeviceId:'not_a_device_digest'});}},
  {label:'trusted-operator',alter(p){p.docs.set('tenants/'+tenantId+'/audit/'+p.transferId,{...p.transfer,newDeviceId:'x'.repeat(43)});}},
  {label:'local-owner-admin',alter(p){p.docs.set('tenants/'+tenantId+'/audit/'+p.adminId,{...p.admin,action:'delete-tenant'});}},
  {label:'local-owner-admin',alter(p){p.docs.set('tenants/'+tenantId+'/audit/'+p.adminId,{...p.admin,operationId:randomUUID()});}},
  {label:'local-owner-admin',alter(p){p.docs.set('tenants/'+tenantId+'/audit/'+p.adminId,{...p.admin,extra:true});}},
 ];
 for(const row of cases){const f=await imageFixture(t,{mutate:row.alter});assert.ok(f.captured.dependencyPlan.required.authUids.includes(row.label));await f.verify();await assert.rejects(prepareImageBoundRecoveryAuthority({image:f.image,authorityEnvelope:f.authority(),authorityMasterKey:f.authorityKey}),/required-uid-inventory/);}
});

test('the same literal in a financial creator, member or manager UID remains a real Auth dependency',async t=>{
 for(const label of ['trusted-operator','local-owner-admin']){
  const f=await imageFixture(t,{extraAuthUids:[label],mutate(p){p.docs.set('tenants/'+tenantId+'/members/'+label,{uid:label,role:'manager',active:true});p.docs.set('tenants/'+tenantId+'/entries/real_creator',{tenantId,creatorUid:label,kind:'sale',totalMinor:100,paidMinor:0});}});assert.deepEqual(f.captured.dependencyPlan.required.authUids,[employee,owner,label].sort());const plan=await prepareImageBoundRecoveryAuthority({image:f.image,authorityEnvelope:f.authority(),authorityMasterKey:f.authorityKey});assert.equal(plan.users,3);disposeImageBoundRecoveryAuthority(plan);
 }
});

test('new policy inventory is authenticated, re-derived and rejects unknown versions or altered evidence',async t=>{
 const f=await imageFixture(t);
 for(const mutation of [p=>{p.required.serverAuditPrincipalPolicyVersion=2;},p=>{p.required.serverAuditPrincipals[0].kind='invented';p.requirementsSha256=authorityDigest(p.required);},p=>{p.required.serverAuditPrincipals=[];p.requirementsSha256=authorityDigest(p.required);},p=>{delete p.required.serverAuditPrincipalPolicyVersion;}]){const ref=changedManifest(f,mutation);await assert.rejects(f.verify(ref),/server-principal-policy|plan-stream-mismatch/);}
});

test('legacy image interpretation stays compatible and incomplete old service-UID inventories fail binding safely',async t=>{
 const f=await imageFixture(t),legacy=changedManifest(f,p=>{delete p.required.serverAuditPrincipalPolicyVersion;delete p.required.serverAuditPrincipals;p.required.authUids=[...p.required.authUids,'trusted-operator','local-owner-admin'].sort();p.requirementsSha256=authorityDigest(p.required);p.missing=[...new Set([...p.missing,'auth-users-missing'])].sort();p.inventoryComplete=false;p.activationBlockers=[...p.missing,'provider-backup-consistency-and-independent-restore-acceptance-required','fresh-auth-device-and-license-enrollment-required','production-activation-not-implemented'];});const old=await f.verify(legacy);assert.equal(old.dependencyPlan.required.serverAuditPrincipalPolicyVersion,undefined);assert.ok(old.dependencyPlan.required.authUids.includes('trusted-operator'));
 await assert.rejects(prepareImageBoundRecoveryAuthority({image:{...f.image,...legacy},authorityEnvelope:f.authority(legacy.manifestSha256),authorityMasterKey:f.authorityKey}),/required-uid-inventory/);
 const none=await imageFixture(t,{includeProducers:false});assert.deepEqual(Object.keys(none.captured.dependencyPlan.required).sort(),['format','version','source','authUids','objectRoots','keyIds'].sort());await none.verify();
});

test('service-principal inventory has an explicit bounded count and never truncates',()=>{
 const collector=createRecoveryDependencyCollector();for(let index=0;index<10_000;index++){const op=randomUUID();collector.observe({collection:'audit',id:'admin_'+op,payload:{action:'set-tenant-enabled',actorUid:'local-owner-admin',atMs,operationId:op}});}const operationId=randomUUID();assert.throws(()=>collector.observe({collection:'audit',id:'admin_'+operationId,payload:{action:'activate-license',actorUid:'local-owner-admin',atMs,operationId}}),/server-principal-limit/);
});
