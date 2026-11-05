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
function fixture({role='manager',disabled=false,time=1_790_000_000_000,archiveViewer=null,activeSnapshots=null}={}) {
 const tenantId='race_tenant',uid='race_owner';
 const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeySpki=key.publicKey.export({format:'der',type:'spki'}).toString('base64url');
 const deviceId=createHash('sha256').update(Buffer.from(publicKeySpki,'base64url')).digest('base64url');
 const issuer=generateKeyPairSync('ed25519'),root='tenants/'+tenantId,rows=new Map(),versions=new Map();
 const events=[],state={attempts:0,beforeTransaction:null,beforeCommit:null};
 const put=(path,value)=>{rows.set(path,structuredClone(value));versions.set(path,(versions.get(path)||0)+1);};
 const remove=path=>{rows.delete(path);versions.set(path,(versions.get(path)||0)+1);};
 const snap=path=>({exists:rows.has(path),data:()=>structuredClone(rows.get(path))});
 // Separate names in this reference factory avoid confusing collection/doc IDs.
 const query=(path,field,value,limit=Infinity)=>({path,field,value,limit});
 const feedQuery=(path,field,value)=>({orderBy:()=>({limit:count=>({async get(){
  const docs=[...rows].filter(([key,row])=>key.startsWith(path+'/')&&row[field]>value).sort((a,b)=>a[1][field]-b[1][field]).slice(0,count).map(([key])=>({id:key.split('/').at(-1),...snap(key)}));
  if(state.afterFeedRead){const hook=state.afterFeedRead;state.afterFeedRead=null;hook();}return {docs};
 }})})});
 const collection=path=>({doc:id=>reference(path+'/'+id),where:(field,operator,value)=>{if(operator==='>')return feedQuery(path,field,value);assert.equal(operator,'==');return {limit:count=>query(path,field,value,count)};}});
 const reference=path=>({path,id:path.split('/').at(-1),collection:name=>collection(path+'/'+name),async get(){events.push(['read',path]);return snap(path);},async set(value){events.push(['unconditional-write',path]);put(path,value);}});
 const db={doc:reference,async runTransaction(callback){
  if(state.beforeTransaction){const hook=state.beforeTransaction;state.beforeTransaction=null;hook();}
  for(let retry=0;retry<4;retry++){
   state.attempts++;const reads=new Map(),writes=[];
   const tx={async get(ref){assert.equal(writes.length,0,'all transaction reads precede writes');events.push(['transaction-read',ref.path]);if(ref.field){const matches=[...rows].filter(([path,value])=>path.startsWith(ref.path+'/')&&path.split('/').length===ref.path.split('/').length+1&&value[ref.field]===ref.value).slice(0,ref.limit);for(const [path]of matches)reads.set(path,versions.get(path)||0);return {docs:matches.map(([path])=>({id:path.split('/').at(-1),...snap(path)}))};}reads.set(ref.path,versions.get(ref.path)||0);return snap(ref.path);},create(ref,value){writes.push({kind:'create',path:ref.path,value});},set(ref,value,options){writes.push({kind:'set',path:ref.path,value,merge:options?.merge===true});},update(ref,value){writes.push({kind:'update',path:ref.path,value});}};
   const result=await callback(tx);
   if(state.beforeCommit){const hook=state.beforeCommit;state.beforeCommit=null;hook();}
   if([...reads].some(([path,version])=>(versions.get(path)||0)!==version)){events.push(['transaction-retry']);continue;}
   for(const write of writes){if(write.kind==='create')assert.equal(rows.has(write.path),false);if(write.kind==='update')assert.equal(rows.has(write.path),true);}
   for(const write of writes){put(write.path,write.kind==='update'||write.merge?{...rows.get(write.path),...write.value}:write.value);events.push(['transaction-write',write.path]);}
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
 const gateway=createGateway({db,auth,archiveViewer,activeSnapshots,now:()=>time,privateKey:()=>issuer.privateKey.export({format:'pem',type:'pkcs8'}),publicKey:()=>issuer.publicKey.export({format:'pem',type:'spki'}),kid:()=> 'test-race-v1'});
 const request=extra=>({auth:{uid,token:{auth_time:Math.floor(time/1000)}},data:{tenantId,deviceId,...extra}});
 const authorized=extra=>request({sessionToken:'test-device-session',...extra});
 const proof=challenge=>({challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.challenge),key.privateKey).toString('base64url')});
 const licensePackage=()=>signPackage({type:'entitlement',version:1,tenantId,licenseId:'paid_race',epoch:2,issuedAtMs:time,notBeforeMs:time,expiresAtMs:null,trialStartMs:null,trial:false,maxDevices:1},{type:'membership',version:1,tenantId,uid,deviceId,role:'manager',epoch:2,entitlementEpoch:2,issuedAtMs:time,expiresAtMs:null,enabled:true},issuer.privateKey,'test-race-v1');
 return {gateway,request,authorized,proof,licensePackage,root,uid,tenantId,deviceId,rows,events,state,put,remove,db,auth,time};
}

test('only omitted or integer v1/v2 sync protocol fields are supported; explicit null is refused before I/O',async()=>{
 const f=fixture();
 for(const protocol of [null,undefined,0,3,'1','2',true,false,[],{}]){
  for(const endpoint of ['syncOperation','pullChanges','getActiveSnapshot']){
   await assert.rejects(f.gateway[endpoint](f.authorized({syncProtocolVersion:protocol})),/sync-upgrade-required/);
  }
 }
 assert.equal(f.events.length,0,'Unsupported protocols do not query, mutate or acknowledge operations.');
});

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

const safetySale=(id,date='2027-08-30')=>({id,kind:'sale',date,partyId:'customer_a',qtyMilli:1000,priceMinor:2000000,totalMinor:2000000,paidMinor:0,unit:'كجم',grade:'أول',note:''});
function closingFixture(options={}){
 const f=fixture({time:Date.UTC(2027,8,3,12),...options});
 f.put(f.root,{...f.rows.get(f.root),sequence:4,archivePolicy:{closedThroughDate:'2027-09-01',closeVersion:1,checkpointSequence:4}});
 f.put(f.root+'/parties/customer_a',{id:'customer_a',kind:'merchant',name:'عميل',openingMinor:0,revision:1});return f;
}
const operation=(id,payload,extra={})=>({id,entity:'entry',payload,expectedRevision:0,...extra});

test('held salary resolution preserves its reason and original month without restating obligations',async()=>{
 const f=closingFixture();f.put(f.root+'/employees/staff_a',{id:'staff_a',name:'موظف',active:true});
 const original={id:'salary_late',entity:'salary_term',expectedRevision:0,payload:{id:'salary_late',employeeId:'staff_a',effectiveMonth:'2027-08',monthlyMinor:100000,revision:1}};
 assert.equal((await f.gateway.syncOperation(f.authorized({operation:original}))).status,'needs_review');
 const correction={id:'salary_current',entity:'salary_term',expectedRevision:0,payload:{...original.payload,id:'salary_current',effectiveMonth:'2027-09'},correctionOfOperationId:original.id,correctionReason:'توثيق المعدل الحالي دون تعديل استحقاق أغسطس'};
 const before=f.rows.get(f.root).sequence;
 const result=await f.gateway.syncOperation(f.authorized({operation:correction,syncProtocolVersion:2}));
 assert.equal(result.status,'accepted');assert.equal(f.rows.get(f.root).sequence,before+1);
 const evidence=f.rows.get(f.root+'/lateOperations/'+original.id);
 assert.equal(evidence.originalBusinessDate,'2027-08-01');assert.equal(evidence.resolutionNote,correction.correctionReason);
 assert.equal(evidence.operation.payload.effectiveMonth,'2027-08');assert.equal(evidence.correctionTermId,'salary_current');
 assert.equal(f.rows.has(f.root+'/salaryTerms/salary_late'),false);assert.equal(f.rows.has(f.root+'/salaryLocks/staff_a_2027-08'),false);
 assert.equal(f.rows.get(f.root+'/salaryTerms/salary_current').effectiveMonth,'2027-09');
 assert.equal(f.rows.get(f.root+'/audit/salary_current').correctionReason,correction.correctionReason);
 assert.deepEqual(await f.gateway.syncOperation(f.authorized({operation:correction,syncProtocolVersion:2})),result);
 assert.equal((await f.gateway.syncOperation(f.authorized({operation:{...correction,correctionReason:'changed'},syncProtocolVersion:2}))).reason,'operation-id-reused');
});

test('salary resolution without an explicit bounded reason leaves evidence and balances untouched',async()=>{
 for(const correctionReason of [undefined,'   ','x'.repeat(1001)]){
  const f=closingFixture();f.put(f.root+'/employees/staff_a',{id:'staff_a',active:true});
  const original={id:'salary_late',entity:'salary_term',expectedRevision:0,payload:{id:'salary_late',employeeId:'staff_a',effectiveMonth:'2027-08',monthlyMinor:100000,revision:1}};
  await f.gateway.syncOperation(f.authorized({operation:original}));const before=f.rows.get(f.root).sequence;
  await assert.rejects(f.gateway.syncOperation(f.authorized({operation:{...original,id:'salary_current',payload:{...original.payload,id:'salary_current',effectiveMonth:'2027-09'},correctionOfOperationId:original.id,...(correctionReason===undefined?{}:{correctionReason})}})),/invalid-argument/);
  assert.equal(f.rows.get(f.root).sequence,before);assert.equal(f.rows.get(f.root+'/lateOperations/'+original.id).status,'needs_review');assert.equal(f.rows.has(f.root+'/salaryTerms/salary_current'),false);
 }
});

test('session revocation during transaction conflicts and cannot commit a financial effect',async()=>{
 for(const phase of ['beforeTransaction','beforeCommit']){
  const f=closingFixture();f.state[phase]=()=>f.remove(f.root+'/sessions/'+hash('test-device-session'));
  await assert.rejects(f.gateway.syncOperation(f.authorized({operation:operation('session_write',safetySale('session_write','2027-09-03'))})),/device-session-expired/);
  assert.equal(f.rows.has(f.root+'/entries/session_write'),false);assert.equal(f.rows.has(f.root+'/operations/session_write'),false);
 }
});

test('closed-period entry retains original evidence exactly once without accepting money or advancing sequence',async()=>{
 const f=closingFixture(),op=operation('late_a',safetySale('late_a'));
 const first=await f.gateway.syncOperation(f.authorized({operation:op}));assert.equal(first.status,'needs_review');assert.equal(first.reason,'closed-period');
 assert.deepEqual(await f.gateway.syncOperation(f.authorized({operation:op})),first);assert.deepEqual(f.rows.get(f.root+'/lateOperations/late_a').operation,op);
 assert.equal(f.rows.get(f.root).sequence,4);assert.equal(f.rows.has(f.root+'/entries/late_a'),false);
 assert.equal((await f.gateway.syncOperation(f.authorized({operation:{...op,payload:{...op.payload,note:'changed'}}}))).reason,'operation-id-reused');
 const current=await f.gateway.syncOperation(f.authorized({operation:operation('current_a',safetySale('current_a','2027-09-03'))}));assert.equal(current.status,'accepted');assert.equal(current.sequence,5);
 const change=f.rows.get(f.root+'/changes/0000000000000005');assert.equal(change.acceptedAtMs,f.time);assert.equal(change.closeVersion,1);
});

test('manager correction posts preserved facts in open period and links original evidence once',async()=>{
 const f=closingFixture(),original=operation('late_correction',safetySale('late_correction'));await f.gateway.syncOperation(f.authorized({operation:original}));
 const corrected=operation('corrected',safetySale('corrected','2027-09-03'),{correctionOfOperationId:original.id});const result=await f.gateway.syncOperation(f.authorized({operation:corrected}));assert.equal(result.status,'accepted');
 assert.deepEqual(await f.gateway.syncOperation(f.authorized({operation:corrected})),result);
 const saved=f.rows.get(f.root+'/entries/corrected');assert.equal(saved.originalBusinessDate,'2027-08-30');assert.equal(saved.correctionOfOperationId,original.id);assert.equal(saved.totalMinor,2000000);
 assert.equal(f.rows.get(f.root+'/lateOperations/'+original.id).status,'corrected');
 await assert.rejects(f.gateway.syncOperation(f.authorized({operation:{...corrected,id:'double',payload:{...corrected.payload,id:'double'}}})),/invalid-late-correction/);assert.equal(f.rows.has(f.root+'/entries/double'),false);
});

test('correction refuses altered financial facts, old/future posting dates and employees',async()=>{
 for(const extra of [{paidMinor:1},{date:'2027-08-31'},{date:'2027-09-04'}]){
  const f=closingFixture();await f.gateway.syncOperation(f.authorized({operation:operation('late',safetySale('late'))}));
  await assert.rejects(f.gateway.syncOperation(f.authorized({operation:operation('fixed',{...safetySale('fixed','2027-09-03'),...extra},{correctionOfOperationId:'late'})})),/correction-facts-changed|correction-period-not-open/);
  assert.equal(f.rows.has(f.root+'/entries/fixed'),false);assert.equal(f.rows.get(f.root+'/lateOperations/late').status,'needs_review');
 }
 const employee=closingFixture({role:'employee'});await assert.rejects(employee.gateway.syncOperation(employee.authorized({operation:operation('fixed',safetySale('fixed','2027-09-03'),{correctionOfOperationId:'late'})})),/permission-denied/);
});

test('unapproved employee submission survives close and manager approval requires explicit current-period correction',async()=>{
 const f=closingFixture(),submission={id:'pending',tenantId:f.tenantId,creatorUid:'employee_author',employeeId:'staff_a',kind:'delivery',date:'2027-08-30',partyId:'customer_a',partyName:'عميل',qtyMilli:1000,grade:'أول',unit:'كجم',originalId:'',amountMinor:0,note:'',status:'pending'};f.put(f.root+'/submissions/pending',submission);
 const review={id:'review_late',entity:'review',expectedRevision:0,payload:{id:'review_late',submissionId:'pending',decision:'approved',entry:{...safetySale('approved'),originalId:''},note:''}};
 assert.equal((await f.gateway.syncOperation(f.authorized({operation:review}))).status,'needs_review');assert.equal(f.rows.get(f.root+'/submissions/pending').status,'pending');assert.equal(f.rows.has(f.root+'/reviewLocks/pending'),false);
 const correction={...review,id:'review_fixed',correctionOfOperationId:review.id,payload:{...review.payload,id:'review_fixed',entry:{...review.payload.entry,id:'approved_fixed',date:'2027-09-03'}}};
 assert.equal((await f.gateway.syncOperation(f.authorized({operation:correction}))).status,'accepted');assert.equal(f.rows.get(f.root+'/submissions/pending').status,'approved');
 assert.equal(f.rows.get(f.root+'/entries/approved_fixed').creatorUid,'employee_author');assert.equal(f.rows.get(f.root+'/entries/approved_fixed').originalBusinessDate,'2027-08-30');
});

test('protocol floor explicitly refuses lost history and sequence exhaustion cannot create unsafe numbers',async()=>{
 const f=closingFixture();f.put(f.root,{...f.rows.get(f.root),historyFloor:4});await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:3,syncProtocolVersion:1})),/resync-required/);
 await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:4,syncProtocolVersion:3})),/sync-upgrade-required/);f.put(f.root,{...f.rows.get(f.root),sequence:Number.MAX_SAFE_INTEGER});
 await assert.rejects(f.gateway.syncOperation(f.authorized({operation:operation('overflow',safetySale('overflow','2027-09-03'))})),/sequence-exhausted/);assert.equal(f.rows.has(f.root+'/entries/overflow'),false);
});

test('archive access is manager-only, unavailable without adapter, rechecks revocation after read, and never posts finance',async()=>{
 const f=fixture(),e=fixture({role:'employee'});await assert.rejects(f.gateway.listArchives(f.authorized({})),/archive-storage-unavailable/);await assert.rejects(e.gateway.listArchives(e.authorized({})),/permission-denied/);
 let accessed=0,active;active=fixture({archiveViewer:{list:async args=>{accessed++;assert.equal(args.tenantId,active.tenantId);active.put(active.root+'/members/'+active.uid,{...active.rows.get(active.root+'/members/'+active.uid),active:false});return {archives:[]};}}});
 await assert.rejects(active.gateway.listArchives(active.authorized({})),/permission-denied/);assert.equal(accessed,1);assert.equal(active.events.some(event=>event[0]==='transaction-write'),false);
});


test('manager feed is not disclosed after membership is revoked or downgraded during the query',async()=>{
 for(const change of [f=>f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),active:false}),f=>{f.put(f.root+'/employees/staff',{active:true});f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),role:'employee',employeeId:'staff'});}]){
  const f=fixture();f.put(f.root+'/changes/0000000000000001',{entity:'entry',id:'private',sequence:1,payload:{totalMinor:10000}});f.state.afterFeedRead=()=>change(f);
  await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:0})),/permission-denied/);
 }
});

test('historical salary terms are held separately instead of changing closed payroll obligations',async()=>{
 const f=closingFixture();f.put(f.root+'/employees/staff_a',{id:'staff_a',name:'Synthetic',active:true});
 const op={id:'late_term',entity:'salary_term',expectedRevision:0,payload:{id:'late_term',employeeId:'staff_a',effectiveMonth:'2027-08',monthlyMinor:100000,revision:1}};
 const result=await f.gateway.syncOperation(f.authorized({operation:op}));assert.equal(result.status,'needs_review');assert.equal(result.originalBusinessDate,'2027-08-01');
 assert.equal(f.rows.has(f.root+'/salaryTerms/late_term'),false);assert.equal(f.rows.has(f.root+'/salaryLocks/staff_a_2027-08'),false);assert.equal(f.rows.get(f.root).sequence,4);
 assert.deepEqual(f.rows.get(f.root+'/lateOperations/late_term').operation,op);
});

test('v2 feed negotiation, tenant minimum and concurrent floor publication fail closed',async()=>{
 const f=fixture();f.put(f.root,{...f.rows.get(f.root),sequence:1});
 f.put(f.root+'/changes/0000000000000001',{entity:'party',id:'p',sequence:1,payload:{}});
 assert.equal((await f.gateway.pullChanges(f.authorized({afterSequence:0,syncProtocolVersion:2}))).syncProtocolVersion,2);
 f.state.afterFeedRead=()=>f.put(f.root,{...f.rows.get(f.root),historyFloor:1,minimumSyncProtocol:2});
 await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:0,syncProtocolVersion:2})),/resync-required/);
 await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:1,syncProtocolVersion:1})),/sync-upgrade-required/);
 assert.equal((await f.gateway.pullChanges(f.authorized({afterSequence:1,syncProtocolVersion:2}))).lastSequence,1);
});
test('snapshot reads derive role/epoch server-side and recheck epoch, session and role after I/O',async()=>{
 for(const mutation of ['epoch','session','role']){
  let f;f=fixture({activeSnapshots:{getHeader:async scope=>{assert.deepEqual(scope,{tenantId:f.tenantId,uid:f.uid,role:'manager',membershipEpoch:1,minimumHistoryFloor:0});
   if(mutation==='epoch')f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),epoch:2});
   if(mutation==='session')f.remove(f.root+'/sessions/'+hash('test-device-session'));
   if(mutation==='role'){f.put(f.root+'/employees/staff',{active:true});f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),role:'employee',employeeId:'staff'});}return {private:'must-not-disclose'};}}});
  await assert.rejects(f.gateway.getActiveSnapshot(f.authorized({syncProtocolVersion:2})),/snapshot-authority-changed|device-session-expired/);
  assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);
 }
 const f=fixture();await assert.rejects(f.gateway.getActiveSnapshot(f.authorized({syncProtocolVersion:2})),/snapshot-storage-unavailable/);
 await assert.rejects(f.gateway.readActiveSnapshotPage(f.authorized({syncProtocolVersion:2,snapshotId:'snapshot',index:0,headerSha256:'x'})),/invalid-argument/);
});
test('archive statement route is manager-only, pins continuations and rechecks revocation',async()=>{
 const e=fixture({role:'employee'});await assert.rejects(e.gateway.readArchiveStatement(e.authorized({year:2026,partyId:'p'})),/permission-denied/);
 let f;f=fixture({archiveViewer:{readStatement:async args=>{assert.equal(args.partyId,'p');f.put(f.root+'/members/'+f.uid,{...f.rows.get(f.root+'/members/'+f.uid),active:false});return {private:'must-not-disclose'};}}});
 await assert.rejects(f.gateway.readArchiveStatement(f.authorized({year:2026,partyId:'p',nextChunk:1})),/archive-continuation-manifest-required/);
 await assert.rejects(f.gateway.readArchiveStatement(f.authorized({year:2026,partyId:'p'})),/permission-denied/);
 assert.equal(f.events.some(e=>e[0]==='transaction-write'),false);
});

test('manager pull refuses missing checkpoint tail rather than report false catch-up',async()=>{
 for(const count of [0,1]){const f=fixture();f.put(f.root,{...f.rows.get(f.root),sequence:2});
  if(count)f.put(f.root+'/changes/0000000000000001',{sequence:1,entity:'party',id:'p',payload:{}});
  await assert.rejects(f.gateway.pullChanges(f.authorized({afterSequence:0,syncProtocolVersion:2})),/resync-required/);
 }
});
test('snapshot publication must cover the current floor even if the catalog is stale',async()=>{
 let f;f=fixture({activeSnapshots:{getHeader:async()=>({header:{checkpointSequence:4,historyFloor:0}})}});
 f.put(f.root,{...f.rows.get(f.root),sequence:10,historyFloor:5});
 await assert.rejects(f.gateway.getActiveSnapshot(f.authorized({syncProtocolVersion:2})),/snapshot-publication-stale/);
});
