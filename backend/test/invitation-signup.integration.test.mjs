/** Real isolated Firestore/Auth emulators. Only namespaced synthetic fixtures. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign,randomBytes} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {provisionTenant,issueEmployeeInvitation,acceptInvitation,invitationTenant} from '../src/enrollment.mjs';
import {createGateway} from '../src/gateway.mjs';
import {canonical,hash} from '../src/validation.mjs';
assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
const app=initializeApp({projectId:DEMO_PROJECT_ID},'signup-'+randomBytes(6).toString('hex'));
const db=getFirestore(app),auth=getAuth(app),prefix='signup_'+randomBytes(8).toString('hex'),time=Date.now(),issuer=generateKeyPairSync('ed25519');let sequence=0;
const gateway=createGateway({db,auth,now:()=>time,privateKey:()=>issuer.privateKey.export({format:'pem',type:'pkcs8'}),publicKey:()=>issuer.publicKey.export({format:'pem',type:'spki'}),kid:()=> 'signup-local-only'});
const makeDevice=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({format:'der',type:'spki'});return {...pair,deviceId:createHash('sha256').update(spki).digest('base64url'),publicKeySpki:spki.toString('base64url')};};
async function user(label,{verified=true,disabled=false}={}){const uid=`${prefix}_${label}_${++sequence}`;await auth.createUser({uid,email:uid+'@example.test',password:'Synthetic_signup_only_123!',emailVerified:verified,disabled});return uid;}
function request(uid,data){return {auth:{uid,token:{auth_time:Math.ceil(Date.now()/1000)+5}},data};}
async function fixture(){const tenantId=`${prefix}_tenant_${++sequence}`,uid=await user('owner'),device=makeDevice(),employeeId='staff',root=db.doc('tenants/'+tenantId);await provisionTenant({db,auth,tenantId,uid,name:'مدير الاختبار',deviceId:device.deviceId,publicKeySpki:device.publicKeySpki,now:time});await root.update({businessName:'منشأة الدعوة التجريبية'});await root.collection('employees').doc(employeeId).set({id:employeeId,name:'الموظف التجريبي',active:true});const challenge=await gateway.bootstrap(request(uid,{tenantId,deviceId:device.deviceId}));const bootstrap=await gateway.bootstrap(request(uid,{tenantId,deviceId:device.deviceId,challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.challenge),device.privateKey).toString('base64url')}));const manager=extra=>request(uid,{tenantId,deviceId:device.deviceId,sessionToken:bootstrap.sessionToken,...extra});return {tenantId,uid,device,employeeId,root,manager,bootstrap,issue:()=>gateway.createEmployeeInvitation(manager({employeeId}))};}
function acceptance(f,uid,device,invitationToken,tenantId=f.tenantId){const challenge=canonical({domain:'strawberry-accept-invitation-v1',tenantId,uid,deviceId:device.deviceId,invitationToken});return request(uid,{tenantId,deviceId:device.deviceId,publicKeySpki:device.publicKeySpki,invitationToken,signature:sign('sha256',Buffer.from(challenge),device.privateKey).toString('base64url')});}
const accept=(r,now=time)=>acceptInvitation({db,auth,request:r,now});
after(async()=>{await db.terminate();await deleteApp(app);});
test('manager issues without an Auth UID; employee creates account afterward and gets employee-only original trial',async()=>{
 const f=await fixture(),issued=await f.issue();assert.equal(invitationTenant(issued.invitationToken),f.tenantId);assert.equal('uid' in issued,false);assert.equal(issued.expiresAtMs-time,7*86400000);
 const uid=await user('new'),device=makeDevice(),result=await accept(acceptance(f,uid,device,issued.invitationToken));assert.deepEqual(result,{status:'accepted',tenantId:f.tenantId,businessName:'منشأة الدعوة التجريبية'});
 const member=(await f.root.collection('members').doc(uid).get()).data();assert.equal(member.role,'employee');assert.equal(member.employeeId,f.employeeId);assert.equal(member.businessName,result.businessName);
 const tenant=(await f.root.get()).data();assert.equal(tenant.trialEndMs,f.bootstrap.entitlement.trialEndMs);assert.equal(tenant.deviceCount,2);assert.equal((await f.root.collection('employeeAccounts').doc(f.employeeId).get()).data().uid,uid);
});
test('real Auth signup remains unclaimed while email unverified; verification permits same code',async()=>{
 const f=await fixture(),{invitationToken}=await f.issue();
 const response=await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-only`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`${prefix}_self_${++sequence}@example.test`,password:'Synthetic_signup_only_123!',returnSecureToken:true})});assert.equal(response.status,200);const registered=await response.json(),uid=registered.localId,device=makeDevice(),r=acceptance(f,uid,device,invitationToken);
 await assert.rejects(accept(r),/permission-denied/);assert.equal((await f.root.collection('invitations').doc(hash(invitationToken)).get()).data().used,false);
 await auth.updateUser(uid,{emailVerified:true});assert.equal((await accept(r)).status,'accepted');
});
test('two concurrent verified accounts racing one code create exactly one membership/device/audit',async()=>{
 const f=await fixture(),{invitationToken}=await f.issue(),uids=await Promise.all([user('one'),user('two')]),devices=[makeDevice(),makeDevice()];
 const results=await Promise.allSettled(uids.map((uid,i)=>accept(acceptance(f,uid,devices[i],invitationToken))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal((await f.root.collection('members').where('employeeId','==',f.employeeId).get()).size,1);assert.equal((await f.root.collection('devices').get()).size,2);assert.equal((await f.root.get()).data().deviceCount,2);assert.equal((await f.root.collection('audit').where('action','==','employee-enrolled').get()).size,1);
});
test('same UID and device can retry a lost acceptance response without extra devices, audit, epochs or trial',async()=>{
 const f=await fixture(),{invitationToken}=await f.issue(),uid=await user('retry'),device=makeDevice(),r=acceptance(f,uid,device,invitationToken);const results=await Promise.all([accept(r),accept(r)]);assert.deepEqual(results[0],results[1]);
 const member=await f.root.collection('members').doc(uid).get();assert.equal(member.data().epoch,1);assert.equal((await f.root.get()).data().deviceCount,2);assert.equal((await f.root.collection('audit').where('action','==','employee-enrolled').get()).size,1);assert.equal((await accept(r,time+8*86400000)).status,'accepted');
 await assert.rejects(accept(acceptance(f,uid,makeDevice(),invitationToken)),/permission-denied/);
});
test('reissue invalidates original code and concurrent issues leave only the current pending pointer usable',async()=>{
 const f=await fixture(),old=await f.issue(),fresh=await f.issue(),uid=await user('reissued'),device=makeDevice();await assert.rejects(accept(acceptance(f,uid,device,old.invitationToken)),/permission-denied/);assert.equal((await accept(acceptance(f,uid,device,fresh.invitationToken))).status,'accepted');
 const second=await fixture(),issued=await Promise.all([second.issue(),second.issue()]),pointer=(await second.root.collection('employeeAccounts').doc(second.employeeId).get()).data().pendingInvitationHash,current=issued.find(x=>hash(x.invitationToken)===pointer),stale=issued.find(x=>hash(x.invitationToken)!==pointer),other=await user('concurrent_issue');assert.ok(current&&stale);await assert.rejects(accept(acceptance(second,other,makeDevice(),stale.invitationToken)),/permission-denied/);assert.equal((await accept(acceptance(second,other,makeDevice(),current.invitationToken))).status,'accepted');
});
test('employeeId account toggle still blocks replay/reissue and can re-enable the original linked account',async()=>{
 const f=await fixture(),{invitationToken}=await f.issue(),uid=await user('disabled'),device=makeDevice(),r=acceptance(f,uid,device,invitationToken);await accept(r);await gateway.setMemberActive(f.manager({employeeId:f.employeeId,active:false}));
 assert.equal((await f.root.collection('members').doc(uid).get()).data().active,false);await assert.rejects(accept(r),/permission-denied/);await assert.rejects(f.issue(),/employee-account-already-linked/);await assert.rejects(accept(acceptance(f,await user('replacement'),makeDevice(),invitationToken)),/permission-denied/);
 await gateway.setMemberActive(f.manager({employeeId:f.employeeId,active:true}));assert.equal((await accept(r)).status,'accepted');assert.equal((await f.root.collection('members').doc(uid).get()).data().epoch,3);assert.equal((await f.root.get()).data().deviceCount,2);
});
test('disabled/deleted employee, manager, manager device, tenant and deleting tenant all refuse pending claims',async()=>{
 const cases=[f=>f.root.collection('employees').doc(f.employeeId).update({active:false}),f=>f.root.collection('employees').doc(f.employeeId).delete(),f=>f.root.collection('members').doc(f.uid).update({active:false}),f=>f.root.collection('devices').doc(f.device.deviceId).update({active:false}),f=>f.root.update({enabled:false}),f=>f.root.update({adminDeleting:'synthetic-delete'}),f=>f.root.delete()];
 for(const mutate of cases){const f=await fixture(),{invitationToken}=await f.issue(),uid=await user('blocked');await mutate(f);await assert.rejects(accept(acceptance(f,uid,makeDevice(),invitationToken)),/permission-denied/);assert.equal((await f.root.collection('members').doc(uid).get()).exists,false);assert.equal((await f.root.collection('invitations').doc(hash(invitationToken)).get()).data().used,false);}
});
test('expired code, tenant substitution, forged key proof and disabled Auth cannot consume an invitation',async()=>{
 const f=await fixture(),{invitationToken}=await f.issue(),uid=await user('invalid'),device=makeDevice();await assert.rejects(accept(acceptance(f,uid,device,invitationToken),time+7*86400000),/permission-denied/);await assert.rejects(accept(acceptance(f,uid,device,invitationToken,'wrong_tenant')),/permission-denied/);
 const bad=acceptance(f,uid,device,invitationToken);bad.data.signature=sign('sha256',Buffer.from('forged'),device.privateKey).toString('base64url');await assert.rejects(accept(bad),/invalid-device-proof/);await auth.updateUser(uid,{disabled:true});await assert.rejects(accept(acceptance(f,uid,device,invitationToken)),/permission-denied/);assert.equal((await f.root.collection('invitations').doc(hash(invitationToken)).get()).data().used,false);
});
test('existing legacy employee member with no lock prevents an invitation even while disabled',async()=>{
 const f=await fixture(),uid=await user('legacy_member');await f.root.collection('members').doc(uid).set({uid,employeeId:f.employeeId,role:'employee',active:false,epoch:2});await assert.rejects(f.issue(),/employee-account-already-linked/);
 await gateway.setMemberActive(f.manager({employeeId:f.employeeId,active:true}));assert.equal((await f.root.collection('members').doc(uid).get()).data().active,true);
});
test('legacy UID-bound issuance/claim remain supported and now retain a durable employee lock',async()=>{
 const f=await fixture(),uid=await user('legacy'),wrong=await user('wrong'),device=makeDevice(),issued=await gateway.createEmployeeInvitation(f.manager({employeeId:f.employeeId,uid}));assert.match(issued.invitationToken,/^[A-Za-z0-9_-]{43}$/);await assert.rejects(accept(acceptance(f,wrong,makeDevice(),issued.invitationToken)),/permission-denied/);assert.equal((await accept(acceptance(f,uid,device,issued.invitationToken))).status,'accepted');await assert.rejects(f.issue(),/employee-account-already-linked/);await gateway.setMemberActive(f.manager({uid,active:false}));assert.equal((await f.root.collection('members').doc(uid).get()).data().active,false);
});
test('pre-update legacy invitation without version or account pointer remains claimable only by its UID',async()=>{
 const f=await fixture(),uid=await user('old_pending'),invitationToken=randomBytes(32).toString('base64url');await f.root.collection('invitations').doc(hash(invitationToken)).set({uid,employeeId:f.employeeId,role:'employee',expiresAtMs:time+86400000,minAuthTime:0,used:false});const device=makeDevice();assert.equal((await accept(acceptance(f,uid,device,invitationToken))).status,'accepted');assert.equal((await f.root.collection('employeeAccounts').doc(f.employeeId).get()).data().uid,uid);
});
test('ambiguous duplicate legacy employee accounts cannot be toggled by employeeId or used for a second invitation',async()=>{
 const f=await fixture();for(const uid of ['legacy_a','legacy_b'])await f.root.collection('members').doc(uid).set({uid,employeeId:f.employeeId,role:'employee',active:false,epoch:1});await assert.rejects(gateway.setMemberActive(f.manager({employeeId:f.employeeId,active:true})),/employee-account-not-linked/);await assert.rejects(f.issue(),/employee-account-already-linked/);
});
