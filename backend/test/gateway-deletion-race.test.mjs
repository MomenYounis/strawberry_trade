import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createGateway} from '../src/gateway.mjs';
import {issueEmployeeInvitation,acceptInvitation} from '../src/enrollment.mjs';
import {signPackage} from '../src/issuer.mjs';
import {canonical,hash} from '../src/validation.mjs';

// An injected MVCC store models Firestore's read-version conflict/retry
// behavior. It lets deletion happen exactly between authority and transaction,
// or after transactional reads, without network access or timing sleeps.
function fixture({role='manager',disabled=false}={}) {
 const time=1_790_000_000_000,tenantId='race_tenant',uid='race_owner';
 const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=key.publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const deviceId=createHash('sha256').update(Buffer.from(publicKeySpki,'base64url')).digest('base64url');
 const issuer=generateKeyPairSync('ed25519'),root='tenants/'+tenantId,rows=new Map(),versions=new Map();
 const events=[],state={attempts:0,beforeTransaction:null,beforeCommit:null};
 const put=(path,value)=>{rows.set(path,structuredClone(value));versions.set(path,(versions.get(path)||0)+1);};
 const remove=path=>{rows.delete(path);versions.set(path,(versions.get(path)||0)+1);};
 const snap=path=>({exists:rows.has(path),data:()=>structuredClone(rows.get(path))});
 // Separate names in this reference factory avoid confusing collection/doc IDs.
 const query=(path,field,value,limit=Infinity)=>({path,field,value,limit});
 const collection=path=>({doc:id=>reference(path+'/'+id),where:(field,operator,value)=>{assert.equal(operator,'==');return {limit:count=>query(path,field,value,count)};}});
 const reference=path=>({path,id:path.split('/').at(-1),collection:name=>collection(path+'/'+name),async get(){events.push(['read',path]);return snap(path);},async set(value){events.push(['unconditional-write',path]);put(path,value);}});
 const db={doc:reference,async runTransaction(callback){
  if(state.beforeTransaction){const hook=state.beforeTransaction;state.beforeTransaction=null;hook();}
  for(let retry=0;retry<4;retry++){
   state.attempts++;const reads=new Map(),writes=[];
   const tx={async get(ref){assert.equal(writes.length,0,'all transaction reads precede writes');events.push(['transaction-read',ref.path]);if(ref.field){const matches=[...rows].filter(([path,value])=>path.startsWith(ref.path+'/')&&path.split('/').length===ref.path.split('/').length+1&&value[ref.field]===ref.value).slice(0,ref.limit);for(const [path]of matches)reads.set(path,versions.get(path)||0);return {docs:matches.map(([path])=>({id:path.split('/').at(-1),...snap(path)}))};}reads.set(ref.path,versions.get(ref.path)||0);return snap(ref.path);},create(ref,value){writes.push({kind:'create',path:ref.path,value});},set(ref,value){writes.push({kind:'set',path:ref.path,value});},update(ref,value){writes.push({kind:'update',path:ref.path,value});}};
   const result=await callback(tx);
   if(state.beforeCommit){const hook=state.beforeCommit;state.beforeCommit=null;hook();}
   if([...reads].some(([path,version])=>(versions.get(path)||0)!==version)){events.push(['transaction-retry']);continue;}
   for(const write of writes){if(write.kind==='create')assert.equal(rows.has(write.path),false);if(write.kind==='update')assert.equal(rows.has(write.path),true);}
   for(const write of writes){put(write.path,write.kind==='update'?{...rows.get(write.path),...write.value}:write.value);events.push(['transaction-write',write.path]);}
   return result;
  }
  throw Error('test-transaction-retry-limit');
 }};
 put(root,{ownerUid:uid,enabled:!disabled,trialStartMs:time-1000,trialEndMs:time-1000+30*86400000,licenseId:'trial_race',entitlementEpoch:1,maxDevices:1});
 put(root+'/members/'+uid,{uid,role,name:'اختبار',active:!disabled,epoch:1,...(role==='employee'?{employeeId:'employee_a'}:{})});
 put(root+'/devices/'+deviceId,{id:deviceId,deviceId,uid,tenantId,publicKeySpki,active:!disabled,role});
 if(role==='employee')put(root+'/employees/employee_a',{name:'موظف اختبار',active:!disabled});
 put(root+'/sessions/'+hash('test-device-session'),{uid,deviceId,expiresAtMs:time+3600000});
 const auth={getUser:async requestedUid=>({uid:requestedUid,emailVerified:true,disabled:false}),revokeRefreshTokens:async target=>events.push(['auth-revoke',target])};
 const gateway=createGateway({db,auth,now:()=>time,privateKey:()=>issuer.privateKey.export({format:'pem',type:'pkcs8'}),publicKey:()=>issuer.publicKey.export({format:'pem',type:'spki'}),kid:()=> 'test-race-v1'});
 const request=extra=>({auth:{uid,token:{auth_time:Math.floor(time/1000)}},data:{tenantId,deviceId,...extra}});
 const authorized=extra=>request({sessionToken:'test-device-session',...extra});
 const proof=challenge=>({challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.challenge),key.privateKey).toString('base64url')});
 const licensePackage=()=>signPackage({type:'entitlement',version:1,tenantId,licenseId:'paid_race',epoch:2,issuedAtMs:time,notBeforeMs:time,expiresAtMs:null,trialStartMs:null,trial:false,maxDevices:1},{type:'membership',version:1,tenantId,uid,deviceId,role:'manager',epoch:2,entitlementEpoch:2,issuedAtMs:time,expiresAtMs:null,enabled:true},issuer.privateKey,'test-race-v1');
 return {gateway,request,authorized,proof,licensePackage,root,uid,tenantId,deviceId,rows,events,state,put,remove,db,auth,time};
}

test('bootstrap creates a challenge only after transactional parent and identity reads',async()=>{
 const f=fixture(),challenge=await f.gateway.bootstrap(f.request());
 assert.equal(challenge.requiresDeviceProof,true);assert.equal(f.state.attempts,1);
 assert.equal(f.events.some(e=>e[0]==='unconditional-write'),false);
 for(const path of [f.root,f.root+'/members/'+f.uid,f.root+'/devices/'+f.deviceId])assert.ok(f.events.some(e=>e[0]==='transaction-read'&&e[1]===path));
 assert.equal(f.rows.get(f.root+'/challenges/'+challenge.challengeId).used,false);
 const result=await f.gateway.bootstrap(f.request(f.proof(challenge)));
 assert.equal(JSON.parse(Buffer.from(result.licensePackage.membership.payload,'base64url')).enabled,true);
});

test('deletion after authority but before transaction rejects without an orphan challenge',async()=>{
 const f=fixture();f.state.beforeTransaction=()=>f.remove(f.root);
 await assert.rejects(f.gateway.bootstrap(f.request()),/permission-denied/);
 assert.equal([...f.rows.keys()].some(path=>path.includes('/challenges/')),false);
 assert.equal(f.events.some(e=>e[0].includes('write')),false);
});

test('deletion after transaction reads conflicts then retry refuses without any child commit',async()=>{
 const f=fixture();f.state.beforeCommit=()=>f.remove(f.root);
 await assert.rejects(f.gateway.bootstrap(f.request()),/permission-denied/);
 assert.equal(f.state.attempts,2);assert.equal(f.events.some(e=>e[0]==='transaction-retry'),true);
 assert.equal([...f.rows.keys()].some(path=>path.includes('/challenges/')),false);
 assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);
});

test('changed device owner, tenant, membership role or employee identity is rejected before challenge creation',async()=>{
 for(const change of [
  f=>f.put(f.root+'/devices/'+f.deviceId,{...f.rows.get(f.root+'/devices/'+f.deviceId),uid:'another-user'}),
  f=>f.put(f.root+'/devices/'+f.deviceId,{...f.rows.get(f.root+'/devices/'+f.deviceId),tenantId:'another-tenant'}),
  f=>f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),role:'other'}),
  f=>f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),employeeId:'changed-employee'}),
 ]){
  const f=fixture();f.state.beforeTransaction=()=>change(f);
  await assert.rejects(f.gateway.bootstrap(f.request()),/permission-denied/);
  assert.equal([...f.rows.keys()].some(path=>path.includes('/challenges/')),false);
 }
 const f=fixture({role:'employee'});f.state.beforeTransaction=()=>f.remove(f.root+'/employees/employee_a');
 await assert.rejects(f.gateway.bootstrap(f.request()),/permission-denied/);
 assert.equal([...f.rows.keys()].some(path=>path.includes('/challenges/')),false);
});

test('disabled manager and employee can still complete proof and receive a signed disabled package',async()=>{
 for(const role of ['manager','employee']){
  const f=fixture({role,disabled:true}),challenge=await f.gateway.bootstrap(f.request());
  const result=await f.gateway.bootstrap(f.request(f.proof(challenge)));
  assert.equal(JSON.parse(Buffer.from(result.licensePackage.membership.payload,'base64url')).enabled,false);
  assert.equal(result.member.role,role);
 }
});

test('deletion marker denies bootstrap before and during challenge or device-proof transactions',async()=>{
 for(const stage of ['authority','challenge-transaction','proof-transaction']){
  const f=fixture();let extra;
  if(stage==='proof-transaction'){const challenge=await f.gateway.bootstrap(f.request());extra=f.proof(challenge);}
  const mark=()=>f.put(f.root,{...f.rows.get(f.root),adminDeleting:'test-delete-operation'});
  if(stage==='authority')mark();else f.state.beforeTransaction=mark;
  const writesBefore=f.events.filter(e=>e[0]==='transaction-write').length;
  await assert.rejects(f.gateway.bootstrap(f.request(extra)),/permission-denied/);
  assert.equal(f.events.filter(e=>e[0]==='transaction-write').length,writesBefore);
 }
});

test('member activation rereads parent and actor/device so concurrent deletion or authority changes cannot leave audit or updates',async()=>{
 for(const change of [
  f=>f.remove(f.root),
  f=>f.put(f.root,{...f.rows.get(f.root),adminDeleting:'test-delete-operation'}),
  f=>f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),active:false}),
  f=>f.put(f.root+'/devices/'+f.deviceId,{...f.rows.get(f.root+'/devices/'+f.deviceId),tenantId:'other-tenant'}),
 ]){
  const f=fixture();f.put(f.root+'/members/target_employee',{uid:'target_employee',role:'employee',active:true,epoch:1});
  f.state.beforeCommit=()=>change(f);
  await assert.rejects(f.gateway.setMemberActive(f.authorized({uid:'target_employee',active:false})),/permission-denied/);
  assert.equal(f.rows.get(f.root+'/members/target_employee').active,true);
  assert.equal(f.events.some(e=>e[0]==='transaction-write'||e[0]==='auth-revoke'),false);
 }
 const f=fixture();f.put(f.root+'/members/target_employee',{uid:'target_employee',role:'employee',active:true,epoch:1});
 await f.gateway.setMemberActive(f.authorized({uid:'target_employee',active:false}));
 assert.equal(f.rows.get(f.root+'/members/target_employee').active,false);assert.equal(f.events.some(e=>e[0]==='auth-revoke'),true);
});

test('sync and license activation reject deleted or deleting parents within their own transactions',async()=>{
 for(const method of ['syncOperation','activateLicense'])for(const change of [f=>f.remove(f.root),f=>f.put(f.root,{...f.rows.get(f.root),adminDeleting:'test-delete-operation'})]){
  const f=fixture();f.state.beforeTransaction=()=>change(f);
  const extra=method==='activateLicense'?{licensePackage:f.licensePackage()}:{operation:{id:'party_a',entity:'party',expectedRevision:0,payload:{id:'party_a',tenantId:f.tenantId,name:'عميل',kind:'merchant',phone:'',favorite:false,openingMinor:0,revision:1}}};
  await assert.rejects(f.gateway[method](f.authorized(extra)),/permission-denied/);
  assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);
 }
});

test('invitation creation reads parent and current manager/device atomically after non-atomic Auth revocation',async()=>{
 for(const change of [
  f=>f.remove(f.root),
  f=>f.put(f.root,{...f.rows.get(f.root),adminDeleting:'test-delete-operation'}),
  f=>f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),role:'employee'}),
  f=>f.put(f.root+'/devices/'+f.deviceId,{...f.rows.get(f.root+'/devices/'+f.deviceId),uid:'other-user'}),
 ]){
  const f=fixture();f.put(f.root+'/employees/target_staff',{name:'موظف',active:true});f.state.beforeCommit=()=>change(f);
  await assert.rejects(f.gateway.createEmployeeInvitation(f.authorized({uid:'new_employee',employeeId:'target_staff'})),/permission-denied/);
  assert.equal(f.events.some(e=>e[0]==='auth-revoke'),true);
  assert.equal([...f.rows.keys()].some(path=>path.includes('/invitations/')),false);
  assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);
 }
 const f=fixture();f.put(f.root+'/employees/target_staff',{name:'موظف',active:true});
 const result=await f.gateway.createEmployeeInvitation(f.authorized({uid:'new_employee',employeeId:'target_staff'}));
 assert.equal(f.rows.get(f.root+'/invitations/'+hash(result.invitationToken)).uid,'new_employee');
});

test('trusted invitation helper also refuses deleted roots without gateway preflight',async()=>{
 const f=fixture();f.put(f.root+'/employees/target_staff',{name:'موظف',active:true});f.remove(f.root);
 await assert.rejects(issueEmployeeInvitation({db:f.db,auth:f.auth,tenantId:f.tenantId,uid:'new_employee',employeeId:'target_staff',now:f.time}),/permission-denied/);
 assert.equal([...f.rows.keys()].some(path=>path.includes('/invitations/')),false);
});

test('invitation acceptance conflicts with deletion and marker and retains normal enrollment',async()=>{
 for(const stage of ['normal','deleted','deleting']){
  const f=fixture(),newUid='new_employee',invitationToken='test-invitation-token',key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=key.publicKey.export({format:'der',type:'spki'}).toString('base64url');
  // Device hashes are SHA-256 over SPKI bytes, not validation.hash's canonical JSON.
  const actualDeviceId=createHash('sha256').update(Buffer.from(publicKeySpki,'base64url')).digest('base64url');
  f.put(f.root+'/employees/target_staff',{name:'موظف',active:true});
  f.put(f.root+'/invitations/'+hash(invitationToken),{uid:newUid,employeeId:'target_staff',role:'employee',expiresAtMs:f.time+86400000,minAuthTime:0,used:false});
  const challenge=canonical({domain:'strawberry-accept-invitation-v1',tenantId:f.tenantId,uid:newUid,deviceId:actualDeviceId,invitationToken});
  const request={auth:{uid:newUid,token:{auth_time:Math.floor(f.time/1000)}},data:{tenantId:f.tenantId,deviceId:actualDeviceId,publicKeySpki,invitationToken,signature:sign('sha256',Buffer.from(challenge),key.privateKey).toString('base64url')}};
  if(stage!=='normal')f.state.beforeCommit=()=>stage==='deleted'?f.remove(f.root):f.put(f.root,{...f.rows.get(f.root),adminDeleting:'test-delete-operation'});
  const action=acceptInvitation({db:f.db,auth:f.auth,request,now:f.time});
  if(stage==='normal'){assert.deepEqual(await action,{status:'accepted',tenantId:f.tenantId,businessName:'اختبار'});assert.equal(f.rows.get(f.root+'/members/'+newUid).active,true);}
  else{await assert.rejects(action,/permission-denied/);assert.equal(f.rows.has(f.root+'/members/'+newUid),false);assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);}
 }
});
