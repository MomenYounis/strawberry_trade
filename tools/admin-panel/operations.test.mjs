import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createAdminOperations,ADMIN_PROJECT_ID} from './operations.mjs';
import {validatePayloads} from '../../backend/src/issuer.mjs';

const DAY=86400000;
function device(){const bytes=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'});return {deviceId:createHash('sha256').update(bytes).digest('base64url'),publicKeySpki:bytes.toString('base64url'),algorithm:'P-256'};}
function fixture(){
  const state={docs:new Map(),users:new Map(),serverMs:1800000000000,wallMs:1000000,authCreates:0,authRevokes:0,mail:[],recursiveCalls:0,failPurge:false,lateWrite:false,loseCommit:false,readPaths:[]};
  class Ref{constructor(path){this.path=path;this.id=path.split('/').at(-1);}collection(name){return new Query(this.path+'/'+name);}async get(){state.readPaths.push(this.path);return snap(this.path);}async listCollections(){const names=new Set([...state.docs.keys()].filter(p=>p.startsWith(this.path+'/')).map(p=>p.slice(this.path.length+1).split('/')[0]));return [...names].map(name=>this.collection(name));}}
  function snap(path){return {id:path.split('/').at(-1),ref:new Ref(path),exists:state.docs.has(path),data:()=>structuredClone(state.docs.get(path)),readTime:{toMillis:()=>state.serverMs}};}
  class Query{constructor(path,filters=[],cap=Infinity,after=null){Object.assign(this,{path,filters,cap,after});}doc(name){return new Ref(this.path+'/'+name);}where(field,operator,value){assert.equal(operator,'==');return new Query(this.path,[...this.filters,[field,value]],this.cap,this.after);}limit(cap){return new Query(this.path,this.filters,cap,this.after);}orderBy(){return this;}startAfter(after){return new Query(this.path,this.filters,this.cap,after);}async get(){const docs=[...state.docs].filter(([p,d])=>p.startsWith(this.path+'/')&&p.split('/').length===this.path.split('/').length+1&&this.filters.every(([k,v])=>d[k]===v)).map(([p])=>snap(p)).sort((a,b)=>a.id.localeCompare(b.id)).filter(s=>!this.after||s.id>this.after).slice(0,this.cap);return {docs,readTime:{toMillis:()=>state.serverMs}};}async listDocuments(){const names=new Set([...state.docs.keys()].filter(p=>p.startsWith(this.path+'/')).map(p=>p.slice(this.path.length+1).split('/')[0]));return [...names].map(name=>this.doc(name));}}
  const db={projectId:ADMIN_PROJECT_ID,databaseId:'(default)',doc:path=>new Ref(path),collection:path=>new Query(path),
    async runTransaction(callback){const writes=[];let writing=false;const tx={get:async ref=>{assert.equal(writing,false,'all reads before writes');return ref instanceof Query?ref.get():snap(ref.path);},getAll:async(...refs)=>{assert.equal(writing,false);return refs.map(r=>snap(r.path));},
      create(ref,value){writing=true;if(state.docs.has(ref.path))throw Error('ALREADY_EXISTS');writes.push(['create',ref.path,structuredClone(value)]);},set(ref,value){writing=true;writes.push(['set',ref.path,structuredClone(value)]);},update(ref,value){writing=true;if(!state.docs.has(ref.path))throw Error('NOT_FOUND');writes.push(['update',ref.path,structuredClone(value)]);},delete(ref){writing=true;writes.push(['delete',ref.path]);}};
      const result=await callback(tx);for(const [kind,path,value]of writes){if(kind==='delete')state.docs.delete(path);else state.docs.set(path,kind==='update'?{...state.docs.get(path),...value}:value);}if(state.loseCommit&&writes.length){state.loseCommit=false;throw Error('LOST COMMIT RESPONSE');}return result;},
    async recursiveDelete(ref){state.recursiveCalls++;assert.equal(state.docs.has(ref.path),false,'parent deleted before recursive purge');if(state.failPurge){state.failPurge=false;throw Error('PURGE FAILED');}for(const path of state.docs.keys())if(path.startsWith(ref.path+'/'))state.docs.delete(path);if(state.lateWrite){state.lateWrite=false;state.docs.set(ref.path+'/challenges/late',{synthetic:true});}}};
  const auth={app:{options:{projectId:ADMIN_PROJECT_ID}},async getUser(uid){const user=state.users.get(uid);if(!user)throw Object.assign(Error(),{code:'auth/user-not-found'});return structuredClone(user);},async getUserByEmail(address){const user=[...state.users.values()].find(u=>u.email===address);if(!user)throw Object.assign(Error(),{code:'auth/user-not-found'});return structuredClone(user);},async createUser(input){assert.equal(input.emailVerified,false);assert.equal(input.disabled,false);state.authCreates++;const uid='created_'+state.authCreates;const user={uid,email:input.email,displayName:input.displayName,emailVerified:false,disabled:false};state.users.set(uid,user);return structuredClone(user);},async revokeRefreshTokens(){state.authRevokes++;throw Error('GLOBAL REVOCATION FORBIDDEN');}};
  const ops=createAdminOperations({db,auth,now:()=>state.wallMs,sendVerificationEmail:async input=>{state.mail.push(input.email);}});
  const addUser=(uid='owner',address=uid+'@example.test',verified=true)=>{state.users.set(uid,{uid,email:address,displayName:uid,emailVerified:verified,disabled:false});return address;};
  const createAction=(tenantId='tenant',uid='owner')=>({type:'create-tenant',tenantId,name:'منشأة تجريبية',ownerUid:uid,expectedEmail:uid+'@example.test',deviceRequest:device(),maxDevices:2});
  async function execute(action){const preview=await ops.previewAction(action);return ops.executeAction({previewId:preview.previewId,confirmation:preview.confirmationText});}
  return {state,db,auth,ops,addUser,createAction,execute};
}

test('wrong target, unverified owner, mismatched device and unknown input fields refuse before writes',async()=>{
  const f=fixture();assert.throws(()=>createAdminOperations({db:{...f.db,projectId:'other'},auth:f.auth}),/wrong-admin-target/);
  f.addUser('owner','owner@example.test',false);await assert.rejects(f.ops.previewAction(f.createAction()),/verified-enabled/);
  f.addUser();const bad=f.createAction();bad.deviceRequest.deviceId='wrong';await assert.rejects(f.ops.previewAction(bad),/invalid-device/);
  await assert.rejects(f.ops.previewAction({...f.createAction(),role:'admin'}),/unexpected-fields/);assert.equal(f.state.docs.size,0);
});
test('previews do not write, expire, require exact confirmation and cannot be replaced at execute',async()=>{
  const f=fixture();f.addUser();const p=await f.ops.previewAction(f.createAction());assert.equal(f.state.docs.size,0);
  await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:'wrong'}),/confirmation/);
  await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText,type:'delete-tenant'}),/unexpected-fields/);
  f.state.wallMs+=300001;await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),/expired/);
});
test('creates trusted original trial, four tenant documents plus minimal history and idempotent receipt',async()=>{
  const f=fixture();f.addUser();const p=await f.ops.previewAction(f.createAction());const result=await f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText});
  const t=f.state.docs.get('tenants/tenant');assert.equal(t.trialStartMs,f.state.serverMs);assert.equal(t.trialEndMs-t.trialStartMs,30*DAY);
  assert.equal([...f.state.docs.keys()].filter(p=>p.startsWith('tenants/tenant')).length,4);assert.equal(f.state.authRevokes,0);
  assert.deepEqual(await f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),result);
  await assert.rejects(f.ops.previewAction(f.createAction('another')),/history-exists/);
});
test('manager device limit, disable/reactivate counters and paid/permanent entitlement match gateway schema',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());f.addUser('second');
  await f.execute({type:'add-manager',tenantId:'tenant',uid:'second',expectedEmail:'second@example.test',name:'مدير ثان',deviceRequest:device()});
  f.addUser('third');await assert.rejects(f.ops.previewAction({type:'add-manager',tenantId:'tenant',uid:'third',expectedEmail:'third@example.test',name:'مدير ثالث',deviceRequest:device()}),/device-limit/);
  const original=f.state.docs.get('tenants/tenant');await f.execute({type:'set-member-active',tenantId:'tenant',uid:'second',active:false});assert.equal(f.state.docs.get('tenants/tenant').managerDeviceCount,1);
  await f.execute({type:'set-member-active',tenantId:'tenant',uid:'second',active:true});assert.equal(f.state.docs.get('tenants/tenant').managerDeviceCount,2);
  const result=await f.execute({type:'activate-license',tenantId:'tenant',unit:'months',count:1,maxDevices:3});const t=f.state.docs.get('tenants/tenant'),e=t.entitlementPayload;
  validatePayloads(e,{type:'membership',version:1,tenantId:'tenant',uid:'owner',deviceId:'synthetic-device',role:'manager',epoch:1,entitlementEpoch:e.epoch,issuedAtMs:e.issuedAtMs,expiresAtMs:null,enabled:true});
  assert.equal(t.trialStartMs,original.trialStartMs);assert.equal(t.trialEndMs,original.trialEndMs);assert.ok(result.expiresAtMs>f.state.serverMs);
  await f.execute({type:'activate-license',tenantId:'tenant',unit:'permanent'});assert.equal(f.state.docs.get('tenants/tenant').entitlementPayload.expiresAtMs,null);
  await assert.rejects(f.ops.previewAction({type:'activate-license',tenantId:'tenant',unit:'days',count:1}),/cannot-be-shortened/);assert.equal(f.state.authRevokes,0);
});
test('stale previews refuse and lost transaction responses recover via atomic operation receipt',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());const p=await f.ops.previewAction({type:'set-tenant-enabled',tenantId:'tenant',enabled:false});
  f.state.docs.get('tenants/tenant').maxDevices=4;await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),/stale-preview/);
  const q=await f.ops.previewAction({type:'activate-license',tenantId:'tenant',unit:'days',count:30});f.state.loseCommit=true;
  await assert.rejects(f.ops.executeAction({previewId:q.previewId,confirmation:q.confirmationText}),/admin-action-incomplete/);
  const once=f.state.docs.get('tenants/tenant').paidUntilMs;await f.ops.executeAction({previewId:q.previewId,confirmation:q.confirmationText});assert.equal(f.state.docs.get('tenants/tenant').paidUntilMs,once);
});
test('account creation is previewed, unverified, password-free in output and email is explicit only',async()=>{
  const f=fixture(),password='Synthetic_Password_123';const p=await f.ops.createAccount({email:'new@example.test',displayName:'حساب',password});
  assert.equal(f.state.authCreates,0);assert.equal(JSON.stringify(p).includes(password),false);const result=await f.ops.executeAction({previewId:p.previewId,confirmation:'CREATE new@example.test'});
  assert.equal(result.account.emailVerified,false);assert.equal(f.state.authCreates,1);assert.deepEqual(f.state.mail,[]);assert.equal(JSON.stringify(result).includes(password),false);
  const q=await f.ops.previewAction({type:'send-verification-email',email:'new@example.test',password});await f.ops.executeAction({previewId:q.previewId,confirmation:q.confirmationText});assert.deepEqual(f.state.mail,['new@example.test']);
});
test('verification email failure reports account-created partial success without creating a duplicate on retry',async()=>{
  const f=fixture();const ops=createAdminOperations({db:f.db,auth:f.auth,now:()=>f.state.wallMs,sendVerificationEmail:async()=>{throw Error('SENSITIVE PROVIDER PAYLOAD');}});
  const p=await ops.previewAction({type:'create-account',email:'new@example.test',displayName:'حساب',password:'Synthetic_123',sendVerificationEmail:true});
  const result=await ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText});assert.equal(result.status,'partial');assert.equal(result.accountCreated,true);assert.equal(result.verificationEmailSent,false);
  assert.deepEqual(await ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),result);assert.equal(f.state.authCreates,1);
});
test('permanent recursive deletion removes parent early, preserves Auth/history and waits for quiescence',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());f.state.docs.set('tenants/tenant/entries/synthetic',{amount:1});f.state.docs.set('tenants/tenant/missing/ghost/nested/orphan',{synthetic:true});
  const p=await f.ops.previewAction({type:'delete-tenant',tenantId:'tenant'});assert.equal(p.confirmationText,'DELETE tenant');const first=await f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText});
  assert.equal(first.status,'delete-pending');assert.equal([...f.state.docs.keys()].some(p=>p.startsWith('tenants/tenant')),false);assert.equal(f.state.users.size,1);assert.equal(f.state.authRevokes,0);
  await assert.rejects(f.ops.previewAction(f.createAction()),/history-exists/);f.state.serverMs+=30001;
  const done=await f.execute({type:'delete-tenant',tenantId:'tenant'});assert.equal(done.status,'deleted');assert.equal(f.state.docs.get('adminTenantHistory/tenant').state,'deleted');
  await assert.rejects(f.ops.previewAction(f.createAction('new-id')),/history-exists/);
});
test('partial delete is resumable with missing parent and refuses a recreated/reenabled parent',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());f.state.failPurge=true;await assert.rejects(f.execute({type:'delete-tenant',tenantId:'tenant'}),/delete-incomplete/);
  assert.equal(f.state.docs.has('tenants/tenant'),false);const calls=f.state.recursiveCalls;f.state.docs.set('tenants/tenant',{enabled:true,ownerUid:'owner'});
  await assert.rejects(f.ops.previewAction({type:'delete-tenant',tenantId:'tenant'}),/recreated-during-deletion/);assert.equal(f.state.recursiveCalls,calls);
  f.state.docs.delete('tenants/tenant');assert.equal((await f.execute({type:'delete-tenant',tenantId:'tenant'})).status,'delete-pending');
});
test('late orphan writes reset quiet observation and are purged without falsely reporting complete',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());f.state.lateWrite=true;
  assert.equal((await f.execute({type:'delete-tenant',tenantId:'tenant'})).status,'delete-pending');assert.equal(f.state.docs.has('tenants/tenant/challenges/late'),true);
  f.state.serverMs+=60000;assert.equal((await f.execute({type:'delete-tenant',tenantId:'tenant'})).status,'delete-pending');
  f.state.serverMs+=30001;assert.equal((await f.execute({type:'delete-tenant',tenantId:'tenant'})).status,'deleted');
});
test('listing and details expose enrollment metadata without financial bodies or session tokens',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());f.state.docs.set('tenants/tenant/entries/private',{secretFinancialMarker:'DO_NOT_READ'});f.state.docs.set('tenants/tenant/sessions/token',{token:'DO_NOT_READ'});
  const list=await f.ops.listTenants(),detail=await f.ops.tenantDetail({tenantId:'tenant'});assert.equal(list.items[0].id,'tenant');assert.equal(detail.members.length,1);
  assert.equal(JSON.stringify({list,detail}).includes('DO_NOT_READ'),false);
});
test('pending deletion remains selectable and resumable after reload with a missing parent',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());await f.execute({type:'delete-tenant',tenantId:'tenant'});
  const reloaded=createAdminOperations({db:f.db,auth:f.auth,now:()=>f.state.wallMs});
  const list=await reloaded.listTenants(),detail=await reloaded.tenantDetail({tenantId:'tenant'});
  assert.equal(list.items.length,1);assert.equal(list.items[0].tenantId,'tenant');assert.equal(list.items[0].deleting,true);
  assert.equal(detail.tenant.missingParent,true);assert.deepEqual(detail.members,[]);assert.deepEqual(detail.devices,[]);
  f.state.serverMs+=30001;const p=await reloaded.previewAction({type:'delete-tenant',tenantId:'tenant'});
  assert.equal((await reloaded.executeAction({previewId:p.previewId,confirmation:p.confirmationText})).status,'deleted');
  assert.equal((await reloaded.listTenants()).items.length,0);
});
test('uncertain account creation consumes the password and cannot create again from the same preview',async()=>{
  const f=fixture(),create=f.auth.createUser;f.auth.createUser=async input=>{await create(input);throw Error('LOST AUTH RESPONSE');};
  const p=await f.ops.previewAction({type:'create-account',email:'new@example.test',displayName:'حساب',password:'Synthetic_123'});
  await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),/account-create-outcome-uncertain/);
  await assert.rejects(f.ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText}),/new-account-preview-required/);
  assert.equal(f.state.authCreates,1);
});

test('manager toggle uses document IDs instead of spoofable stored IDs',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  const [path,value]=[...f.state.docs].find(([path])=>path.startsWith('tenants/tenant/devices/'));
  value.id='unrelated';f.state.docs.set('tenants/tenant/devices/unrelated',{uid:'another',role:'employee',active:true});
  await f.execute({type:'set-member-active',tenantId:'tenant',uid:'owner',active:false});
  assert.equal(f.state.docs.get(path).active,false);assert.equal(f.state.docs.get('tenants/tenant/devices/unrelated').active,true);
});
test('hard deletion strips arbitrary enrollment-history bodies and keeps original trial times',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  const historyPath='adminEnrollmentHistory/'+createHash('sha256').update('owner').digest('hex');
  const history=f.state.docs.get(historyPath),original={...history};history.financialBody={amount:999};history.name='PRIVATE BUSINESS NAME';
  f.state.docs.get('tenants/tenant').trialStartMs+=1000;
  await f.execute({type:'delete-tenant',tenantId:'tenant'});
  assert.deepEqual(Object.keys(f.state.docs.get(historyPath)).sort(),['deletedAtMs','status','tenantId','trialEndMs','trialStartMs']);
  assert.equal(f.state.docs.get(historyPath).trialStartMs,original.trialStartMs);
  assert.equal(JSON.stringify([...f.state.docs]).includes('PRIVATE BUSINESS NAME'),false);
  assert.equal(JSON.stringify([...f.state.docs]).includes('financialBody'),false);
});
test('a stale initial delete preview cannot silently adopt another in-progress deletion',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  const first=await f.ops.previewAction({type:'delete-tenant',tenantId:'tenant'}),second=await f.ops.previewAction({type:'delete-tenant',tenantId:'tenant'});
  await f.ops.executeAction({previewId:first.previewId,confirmation:first.confirmationText});const calls=f.state.recursiveCalls;
  await assert.rejects(f.ops.executeAction({previewId:second.previewId,confirmation:second.confirmationText}),/stale-preview/);
  assert.equal(f.state.recursiveCalls,calls);
});
test('paid activation adds to remaining trial time and preserves its original identity',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  const trial={...f.state.docs.get('tenants/tenant')};
  await f.execute({type:'activate-license',tenantId:'tenant',unit:'days',count:3});
  assert.equal(f.state.docs.get('tenants/tenant').paidUntilMs,trial.trialEndMs+3*DAY);
  assert.equal(f.state.docs.get('tenants/tenant').trialStartMs,trial.trialStartMs);
  await f.execute({type:'activate-license',tenantId:'tenant',unit:'days',count:2});
  assert.equal(f.state.docs.get('tenants/tenant').paidUntilMs,trial.trialEndMs+5*DAY);
});
test('unknown device algorithm and account-alias operation override cannot select another action',async()=>{
  const f=fixture();f.addUser();const action=f.createAction();action.deviceRequest.algorithm='RSA-SHA256';
  await assert.rejects(f.ops.previewAction(action),/invalid-device/);
  await assert.rejects(f.ops.createAccount({type:'delete-tenant',tenantId:'tenant'}),/unexpected-fields/);
  assert.equal(f.state.docs.size,0);
});
test('manager toggle refuses an over-limit atomic write instead of changing a subset',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  for(let i=0;i<496;i++)f.state.docs.set('tenants/tenant/devices/synthetic_'+i,{uid:'owner',role:'manager',active:false});
  await assert.rejects(f.ops.previewAction({type:'set-member-active',tenantId:'tenant',uid:'owner',active:false}),/manager-device-limit-exceeded/);
  assert.equal(f.state.docs.get('tenants/tenant/members/owner').active,true);
});

test('read views add public owner email, reuse its short cache and recover legacy member business names',async()=>{
  const f=fixture();f.addUser();await f.execute(f.createAction());
  const root=f.state.docs.get('tenants/tenant');delete root.name;delete root.businessName;
  f.state.docs.get('tenants/tenant/members/owner').businessName='دفتر الفراولة';
  Object.assign(f.state.users.get('owner'),{refreshToken:'DO_NOT_EXPOSE_AUTH',customClaims:{secret:'DO_NOT_EXPOSE_AUTH'}});
  const originalGet=f.auth.getUser;let calls=0;f.auth.getUser=async uid=>{calls++;return originalGet(uid);};
  const list=await f.ops.listTenants();assert.equal(list.items[0].ownerEmail,'owner@example.test');assert.equal(list.items[0].businessName,'دفتر الفراولة');
  assert.equal(f.state.readPaths.filter(p=>p==='tenants/tenant/members/owner').length,1);
  const detail=await f.ops.tenantDetail({tenantId:'tenant'});assert.equal(detail.tenant.ownerEmail,'owner@example.test');assert.equal(detail.tenant.businessName,'دفتر الفراولة');
  assert.equal(calls,1,'detail reuses cached public email');assert.equal(f.state.readPaths.filter(p=>p==='tenants/tenant/members/owner').length,1,'detail reuses queried members');
  assert.equal(JSON.stringify({list,detail}).includes('DO_NOT_EXPOSE_AUTH'),false);
  root.name='اسم المنشأة الحالي';const previousReads=f.state.readPaths.length;const current=await f.ops.listTenants();
  assert.equal(current.items[0].name,'اسم المنشأة الحالي');assert.equal(f.state.readPaths.length,previousReads,'named roots need no member document read');
  f.state.wallMs+=30001;await f.ops.listTenants();assert.equal(calls,2,'public cache expires');
});
test('batch owner profiles stay within 100 users, whitelist emails and tolerate missing/failed lookups',async()=>{
  const f=fixture();
  for(let i=0;i<100;i++)f.state.docs.set('tenants/t'+String(i).padStart(3,'0'),{ownerUid:'owner'+i,name:'منشأة '+i,enabled:true});
  for(let i=100;i<200;i++)f.state.docs.set('adminTenantHistory/t'+i,{ownerUid:'owner'+i,state:'deleting',operationId:'op'+i});
  const batches=[];f.auth.getUsers=async identifiers=>{
    batches.push(identifiers);assert.ok(identifiers.length<=100);
    if(batches.length===2)throw Error('DO_NOT_EXPOSE_PROVIDER_RESPONSE');
    return {users:identifiers.slice(0,-1).map(({uid})=>({uid,email:uid+'@example.test',passwordHash:'DO_NOT_EXPOSE_AUTH'})),notFound:[identifiers.at(-1)]};
  };
  const list=await f.ops.listTenants({limit:100});assert.equal(list.items.length,200);assert.equal(batches.length,2);
  assert.equal(list.items.find(t=>t.ownerUid==='owner0').ownerEmail,'owner0@example.test');
  assert.equal(list.items.find(t=>t.ownerUid==='owner99').ownerEmail,'');assert.equal(list.items.find(t=>t.ownerUid==='owner100').ownerEmail,'');
  assert.equal(JSON.stringify(list).includes('DO_NOT_EXPOSE'),false);
  const detail=await f.ops.tenantDetail({tenantId:'t100'});assert.equal(detail.tenant.deleting,true);assert.equal(detail.tenant.ownerEmail,'');assert.equal(batches.length,2);
  f.state.wallMs+=5001;f.auth.getUsers=async()=>({users:[{uid:'owner100',email:'recovered@example.test',passwordHash:'DO_NOT_EXPOSE_AUTH'}]});
  assert.equal((await f.ops.tenantDetail({tenantId:'t100'})).tenant.ownerEmail,'recovered@example.test');
});
