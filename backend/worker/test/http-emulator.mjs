// Real local workerd + emulator acceptance. No real Google credentials/accounts.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {initializeApp,cert,deleteApp} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {provisionTenant} from '../../src/enrollment.mjs';
import {canonical} from '../../src/validation.mjs';
import {signPackage,verifyPackage} from '../../src/issuer.mjs';

const projectId='demo-strawberry-flutter',base='http://127.0.0.1:8788';
process.env.GCLOUD_PROJECT=projectId;
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:18080';
process.env.FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:19099';
const text=await readFile(new URL('../.dev.vars.emulator',import.meta.url),'utf8');
assert(text.startsWith('# Synthetic loopback fixtures. These are not Google credentials.'));
const values=Object.fromEntries(text.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{
 const split=line.indexOf('='),value=line.slice(split+1);return [line.slice(0,split),
  value.startsWith("'")&&value.endsWith("'")?value.slice(1,-1):JSON.parse(value)];
}));
const account=JSON.parse(values.FIREBASE_SERVICE_ACCOUNT_JSON);
assert.equal(account.project_id,projectId);
assert.equal(account.client_email,'synthetic-worker@demo-strawberry-flutter.iam.gserviceaccount.com');
const nonce=Date.now().toString(36),uid='worker_http_manager_'+nonce,employeeUid='worker_http_staff_'+nonce,tenantId='worker_http_'+nonce;
const app=initializeApp({projectId,credential:cert(account)},'worker-http-test-'+nonce),db=initializeFirestore(app,{preferRest:true}),auth=getAuth(app);
const checks=[];
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks.push(label);};
function device(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({type:'spki',format:'der'});return {...pair,publicKeySpki:spki.toString('base64url'),deviceId:createHash('sha256').update(spki).digest('base64url')};}
const managerDevice=device(),employeeDevice=device();
async function signup(email,password){const response=await fetch('http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});const result=await response.json();assert.equal(response.status,200,'Synthetic employee self-registration');assert.ok(result.localId&&result.idToken);return result;}
async function login(email,password){const response=await fetch('http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});const result=await response.json();assert.ok(result.idToken,'Synthetic Auth token');return result.idToken;}
async function raw(method,data,token){const response=await fetch(base+'/'+method,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({data}),signal:AbortSignal.timeout(60000)});return {status:response.status,body:await response.json()};}
async function call(method,data,token){const result=await raw(method,data,token);assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(Object.hasOwn(result.body,'result'));return result.body.result;}
async function bootstrap(identity,token){const c=await call('bootstrap',{tenantId,deviceId:identity.deviceId},token);return call('bootstrap',{tenantId,deviceId:identity.deviceId,challengeId:c.challengeId,signature:sign('sha256',Buffer.from(c.challenge),identity.privateKey).toString('base64url')},token);}

try {
 const health=await fetch(base+'/health',{signal:AbortSignal.timeout(15000)});
 equal(health.status,200,'Durable Object HTTP health');
 equal((await raw('bootstrap',{tenantId,deviceId:managerDevice.deviceId})).status,401,'Missing ID token rejected');
 equal((await raw('bootstrap',{tenantId,deviceId:managerDevice.deviceId},'forged.token.value')).status,401,'Forged ID token rejected by real Admin verifier');
 const password='Synthetic_http_92',email=uid+'@example.test';
 await auth.createUser({uid,email,password,emailVerified:true});
 await auth.createUser({uid:employeeUid,email:employeeUid+'@example.test',password,emailVerified:true});
 await provisionTenant({db,auth,tenantId,uid,name:'Synthetic HTTP manager',deviceId:managerDevice.deviceId,publicKeySpki:managerDevice.publicKeySpki});
 const token=await login(email,password),claims=await auth.verifyIdToken(token,true);
 equal(claims.uid,uid,'Emulator Firebase token has expected verified UID');
 const session=await bootstrap(managerDevice,token);
 const license=verifyPackage(session.licensePackage,values.LICENSE_PUBLIC_KEY_PEM,'worker-emulator-only');
 equal(license.membership.deviceId,managerDevice.deviceId,'P-256 challenge binds signed membership to installation');
 equal(license.entitlement.expiresAtMs-license.entitlement.trialStartMs,30*24*60*60*1000,'Signed trial exactly thirty days');
 const scoped=data=>({tenantId,deviceId:managerDevice.deviceId,sessionToken:session.sessionToken,...data});
 const send=(id,entity,payload)=>call('syncOperation',scoped({operation:{id,entity,payload,expectedRevision:0}}),token);
 const party={id:'party_http',kind:'merchant',name:'تاجر تجريبي',openingMinor:0,phone:'',favorite:false};
 equal((await send('party_http_op','party',party)).status,'accepted','Party committed through real HTTP gateway');
 const invoice={id:'invoice_http',kind:'sale',date:'2026-10-19',partyId:party.id,partyName:'forged',creatorUid:'forged',qtyMilli:10000,priceMinor:2000,totalMinor:20000,paidMinor:5000,unit:'كجم',grade:'أول',note:'',originalId:'',employeeId:'',salaryMonth:'',revision:1};
 const first=await send('invoice_http_op','entry',invoice),duplicate=await send('invoice_http_op','entry',invoice);
 equal(first.status,'accepted','Financial invoice accepted');equal(duplicate,first,'Retry returns same receipt');
 equal((await db.collection('tenants/'+tenantId+'/entries').get()).size,1,'Exactly one financial effect');
 const saved=(await db.doc('tenants/'+tenantId+'/entries/'+invoice.id).get()).data();
 equal(saved.totalMinor,20000,'Integer financial total preserved');equal(saved.creatorUid,uid,'Creator derived from verified token');equal(saved.partyName,party.name,'Counterparty derived from tenant directory');
 const invalid=await send('invalid_total_op','entry',{...invoice,id:'invalid_total',totalMinor:1,paidMinor:0});
 equal(invalid.status,'conflict','Invalid accounting retains conflict receipt');
 const pulled=await call('pullChanges',scoped({afterSequence:0,limit:500}),token);
 equal(pulled.changes.filter(change=>change.entity==='entry').length,1,'Pull includes one accepted invoice');
 equal((await raw('pullChanges',{...scoped({afterSequence:0}),tenantId:'other_tenant'},token)).status,403,'Forged tenant denied');
 const employeeId='staff_http';
 equal((await send('staff_http_op','employee',{id:employeeId,name:'عامل تجريبي',phone:'',active:true})).status,'accepted','Employee directory write via HTTP');
 const invitation=await call('createEmployeeInvitation',scoped({uid:employeeUid,employeeId}),token);
 check(typeof invitation.invitationToken==='string','Verified-account employee invitation issued');
 const employeeToken=await login(employeeUid+'@example.test',password);
 const invitationProof=canonical({domain:'strawberry-accept-invitation-v1',tenantId,uid:employeeUid,deviceId:employeeDevice.deviceId,invitationToken:invitation.invitationToken});
 const accepted=await call('acceptInvitation',{tenantId,deviceId:employeeDevice.deviceId,publicKeySpki:employeeDevice.publicKeySpki,invitationToken:invitation.invitationToken,signature:sign('sha256',Buffer.from(invitationProof),employeeDevice.privateKey).toString('base64url')},employeeToken);
 equal(accepted.status,'accepted','Invitation acceptance has real Auth and device signature');
 const employeeSession=await bootstrap(employeeDevice,employeeToken);
 equal(employeeSession.member.role,'employee','Employee cannot self-promote');
 const employeePull=await call('pullChanges',{tenantId,deviceId:employeeDevice.deviceId,sessionToken:employeeSession.sessionToken,afterSequence:0,limit:500},employeeToken);
 check(!JSON.stringify(employeePull).includes('priceMinor'),'Employee feed omits manager prices');
 // Manager creates a fresh one-use invitation before any employee account exists.
 const selfEmployeeId='staff_self_signup';
 equal((await send('staff_self_signup_op','employee',{id:selfEmployeeId,name:'موظف يسجل بنفسه',phone:'',active:true})).status,'accepted','Self-signup employee directory committed');
 const superseded=await call('createEmployeeInvitation',scoped({employeeId:selfEmployeeId}),token);
 const selfInvitation=await call('createEmployeeInvitation',scoped({employeeId:selfEmployeeId}),token);
 check(selfInvitation.invitationToken.startsWith('v2.'),'Manager creates versioned invitation without an account UID');
 equal(Buffer.from(selfInvitation.invitationToken.split('.')[1],'base64url').toString('utf8'),tenantId,'Invitation supplies the canonical tenant selector');
 check(!Object.hasOwn(selfInvitation,'uid'),'Invitation does not require a precreated account');
 const selfEmail='self_signup_'+nonce+'@example.test',selfSignup=await signup(selfEmail,password),selfUid=selfSignup.localId,selfDevice=device();
 const selfProof=invitationToken=>({tenantId,deviceId:selfDevice.deviceId,publicKeySpki:selfDevice.publicKeySpki,invitationToken,signature:sign('sha256',Buffer.from(canonical({domain:'strawberry-accept-invitation-v1',tenantId,uid:selfUid,deviceId:selfDevice.deviceId,invitationToken})),selfDevice.privateKey).toString('base64url')});
 equal((await raw('acceptInvitation',selfProof(selfInvitation.invitationToken),selfSignup.idToken)).status,403,'Unverified self-registered email cannot consume invitation');
 equal((await db.doc('tenants/'+tenantId+'/invitations/'+createHash('sha256').update(selfInvitation.invitationToken).digest('hex')).get()).data().used,false,'Email verification refusal retains unused invitation');
 // Only the loopback Admin fixture simulates clicking the confirmation link.
 await auth.updateUser(selfUid,{emailVerified:true});
 const selfToken=await login(selfEmail,password);
 equal((await raw('acceptInvitation',selfProof(superseded.invitationToken),selfToken)).status,403,'Reissued invitation invalidates the old pending code');
 const selfAccepted=await call('acceptInvitation',selfProof(selfInvitation.invitationToken),selfToken);
 equal(selfAccepted.status,'accepted','Verified self-signup claims manager invitation through HTTP');
 equal(selfAccepted.tenantId,tenantId,'Claim response returns authoritative tenant');
 check(typeof selfAccepted.businessName==='string'&&selfAccepted.businessName.length>0,'Claim response returns authoritative business name');
 equal(await call('acceptInvitation',selfProof(selfInvitation.invitationToken),selfToken),selfAccepted,'Exact claimant retries a lost response without a second enrollment');
 const accountRef=db.doc('tenants/'+tenantId+'/employeeAccounts/'+selfEmployeeId),account=(await accountRef.get()).data();
 equal(account.uid,selfUid,'Employee account lock binds the first verified UID');
 equal(account.deviceId,selfDevice.deviceId,'Employee account lock binds original device');
 const selfSession=await bootstrap(selfDevice,selfToken);
 equal(selfSession.member.role,'employee','Self-signup receives employee-only membership');
 equal(selfSession.entitlement.trialStartMs,session.entitlement.trialStartMs,'Employee self-signup preserves existing trial start');
 equal(selfSession.entitlement.trialEndMs,session.entitlement.trialEndMs,'Employee self-signup preserves existing trial end');
 check([400,403].includes((await raw('createEmployeeInvitation',scoped({employeeId:selfEmployeeId}),token)).status),'Linked employee cannot receive a replacement account invite');
 const attackerDevice=device(),attackerProof={tenantId,deviceId:attackerDevice.deviceId,publicKeySpki:attackerDevice.publicKeySpki,invitationToken:selfInvitation.invitationToken,signature:sign('sha256',Buffer.from(canonical({domain:'strawberry-accept-invitation-v1',tenantId,uid:employeeUid,deviceId:attackerDevice.deviceId,invitationToken:selfInvitation.invitationToken})),attackerDevice.privateKey).toString('base64url')};
 equal((await raw('acceptInvitation',attackerProof,employeeToken)).status,403,'Consumed invitation cannot enroll a different verified account or device');
 equal((await call('setMemberActive',scoped({employeeId:selfEmployeeId,active:false}),token)).status,'accepted','Manager disables self-signup employee by directory ID');
 const disabledSelfToken=await login(selfEmail,password);
 equal((await raw('acceptInvitation',selfProof(selfInvitation.invitationToken),disabledSelfToken)).status,403,'Consumed invitation retry cannot reactivate disabled employee');
 equal((await db.doc('tenants/'+tenantId+'/members/'+selfUid).get()).data().active,false,'Denied invitation retry preserves disabled membership');
 const disabledSelfSession=await bootstrap(selfDevice,disabledSelfToken);
 equal(verifyPackage(disabledSelfSession.licensePackage,values.LICENSE_PUBLIC_KEY_PEM,'worker-emulator-only').membership.enabled,false,'Self-signup employee receives signed disabled membership');
 equal((await call('setMemberActive',scoped({employeeId:selfEmployeeId,active:true}),token)).status,'accepted','Manager reactivates same self-signup account by directory ID');
 equal((await accountRef.get()).data().uid,selfUid,'Reactivation preserves original account binding');
 const reactivatedSelfToken=await login(selfEmail,password),reactivatedSelfSession=await bootstrap(selfDevice,reactivatedSelfToken);
 equal(verifyPackage(reactivatedSelfSession.licensePackage,values.LICENSE_PUBLIC_KEY_PEM,'worker-emulator-only').membership.enabled,true,'Reactivated employee resumes existing signed membership');
 const now=Date.now()-1000,entitlement={type:'entitlement',version:1,tenantId,licenseId:'paid_'+nonce,epoch:2,issuedAtMs:now,notBeforeMs:now,expiresAtMs:null,trialStartMs:null,trial:false,maxDevices:1};
 const membership={type:'membership',version:1,tenantId,uid,deviceId:managerDevice.deviceId,role:'manager',epoch:session.member.epoch+1,entitlementEpoch:2,issuedAtMs:now,expiresAtMs:null,enabled:true};
 const {createPrivateKey}=await import('node:crypto');
 const paid=signPackage(entitlement,membership,createPrivateKey(values.LICENSE_PRIVATE_KEY_PEM),'worker-emulator-only');
 equal((await call('activateLicense',scoped({licensePackage:paid}),token)).status,'accepted','External gateway verifies issuer-signed activation');
 equal((await call('setMemberActive',scoped({uid:employeeUid,active:false}),token)).status,'accepted','Manager employee disable via HTTP');
 const denied=await raw('pullChanges',{tenantId,deviceId:employeeDevice.deviceId,sessionToken:employeeSession.sessionToken,afterSequence:0},employeeToken);
 check([401,403].includes(denied.status),'Disabled employee loses connected access');
 const currentEmployeeToken=await login(employeeUid+'@example.test',password),disabledSession=await bootstrap(employeeDevice,currentEmployeeToken);
 equal(verifyPackage(disabledSession.licensePackage,values.LICENSE_PUBLIC_KEY_PEM,'worker-emulator-only').membership.enabled,false,'Known disabled device obtains signed revocation certificate');
 const root=db.doc('tenants/'+tenantId),beforePages=(await root.get()).data().sequence;
 for(let offset=0;offset<600;offset+=500){
  const batch=db.batch();
  for(let i=offset;i<Math.min(offset+500,600);i++){
   const sequence=beforePages+i+1,id='page_fixture_'+i;
   batch.create(root.collection('changes').doc(String(sequence).padStart(16,'0')),
    {entity:'party',id,sequence,payload:{id,tenantId,name:'سجل اختبار ترقيم '.repeat(8),kind:'merchant',openingMinor:0,phone:'',favorite:false,revision:1}});
  }
  await batch.commit();
 }
 await root.update({sequence:beforePages+600});
 const page1=await call('pullChanges',scoped({afterSequence:0,limit:500}),token);
 const page2=await call('pullChanges',scoped({afterSequence:page1.lastSequence,limit:500}),token);
 equal(page1.changes.length,500,'Durable Object serializes actual 500-record feed page');
 check(page1.hasMore&&!page2.hasMore,'Cursor reports remaining records accurately');
 equal(new Set([...page1.changes,...page2.changes].map(change=>change.sequence)).size,beforePages+600,'Two HTTP pages preserve all sequence IDs without duplication');
 equal(page2.lastSequence,beforePages+600,'HTTP page cursor reaches complete synthetic history');
 const summary={passed:true,checks:checks.length,assertions:checks,transport:'real local workerd Worker → one SQLite Durable Object → HTTP factory → emulator Admin SDK',projectId,firestore:'127.0.0.1:18080',auth:'127.0.0.1:19099',cloudDeployed:false,productionCredentialsUsed:false,cloudCpuQuotaMeasured:false};
 await writeFile(new URL('../test-results.local.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify(summary));
} finally {await db.terminate();await deleteApp(app);}
