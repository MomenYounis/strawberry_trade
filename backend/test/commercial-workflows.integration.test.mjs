import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase-admin/app';import {getFirestore} from 'firebase-admin/firestore';import {getAuth} from 'firebase-admin/auth';
import {createGateway} from '../src/gateway.mjs';import {provisionTenant,issueEmployeeInvitation,acceptInvitation} from '../src/enrollment.mjs';
import {canonical} from '../src/validation.mjs';import {assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';
import {execFileSync} from 'node:child_process';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const projectId='demo-strawberry-flutter';assertDemoOperatorEnvironment(projectId,process.env);
const app=initializeApp({projectId},'commercial-campaign'),db=getFirestore(app),auth=getAuth(app),issuer=generateKeyPairSync('ed25519'),time=Date.now();
const gateway=createGateway({db,auth,now:()=>time,privateKey:()=>issuer.privateKey.export({format:'pem',type:'pkcs8'}),publicKey:()=>issuer.publicKey.export({format:'pem',type:'spki'})});
after(()=>deleteApp(app));
function device(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({type:'spki',format:'der'});return {...pair,deviceId:createHash('sha256').update(spki).digest('base64url'),publicKeySpki:spki.toString('base64url')};}
const request=(who,data)=>({auth:{uid:who.uid,token:{auth_time:Math.ceil(Date.now()/1000)+1}},data:{tenantId:who.tenantId,deviceId:who.device.deviceId,...(who.sessionToken?{sessionToken:who.sessionToken}:{}),...data}});
async function session(who){const challenge=await gateway.bootstrap(request(who,{}));const response=await gateway.bootstrap(request(who,{challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.challenge),who.device.privateKey).toString('base64url')}));return {...who,sessionToken:response.sessionToken,bootstrap:response};}
function entry(id,extra={}){return {id,kind:'sale',date:'2026-10-18',partyId:'merchant',partyName:'',qtyMilli:10000,priceMinor:2000,totalMinor:20000,paidMinor:5000,grade:'A',unit:'kg',originalId:'',employeeId:'',salaryMonth:'',note:'',revision:1,...extra};}
function payment(id,kind,totalMinor,extra={}){return entry(id,{kind,totalMinor,paidMinor:totalMinor,qtyMilli:0,priceMinor:0,partyId:'',grade:'',unit:'',...extra});}
test('independent financial oracle across two businesses, manager/employee devices, retries, returns, reversals, reviews and replacement enrollment',async()=>{
 const businesses=[];
 for(const suffix of ['a','b']){
  const tenantId='campaign_'+suffix,managerId='campaign_manager_'+suffix,employeeUid='campaign_employee_'+suffix;
  for(const uid of [managerId,employeeUid]){await auth.deleteUser(uid).catch(()=>{});await auth.createUser({uid,email:uid+'@example.test',emailVerified:true,password:'Synthetic_only_92'});}
  const managerDevice=device(),employeeDevice=device();
  await provisionTenant({db,auth,tenantId,uid:managerId,name:'Synthetic '+suffix,deviceId:managerDevice.deviceId,publicKeySpki:managerDevice.publicKeySpki,now:time});
  const manager=await session({uid:managerId,tenantId,device:managerDevice});
  const send=(who,id,entity,payload,protocol=2)=>gateway.syncOperation(request(who,{operation:{id,entity,payload,expectedRevision:0},...(protocol===1?{}:{syncProtocolVersion:protocol})}));
  for(const [id,kind,openingMinor] of [['merchant','merchant',5000],['supplier','supplier',3000]])assert.equal((await send(manager,id,'party',{id,name:id,kind,openingMinor,revision:1})).status,'accepted');
  assert.equal((await send(manager,'staff','employee',{id:'staff',name:'Synthetic employee',active:true,revision:1})).status,'accepted');
  const invitationToken=await issueEmployeeInvitation({db,auth,tenantId,uid:employeeUid,employeeId:'staff',now:time});
  const proof=canonical({domain:'strawberry-accept-invitation-v1',tenantId,uid:employeeUid,deviceId:employeeDevice.deviceId,invitationToken});
  await acceptInvitation({db,auth,now:time,request:{auth:request({uid:employeeUid,tenantId,device:employeeDevice},{}).auth,data:{tenantId,deviceId:employeeDevice.deviceId,publicKeySpki:employeeDevice.publicKeySpki,invitationToken,signature:sign('sha256',Buffer.from(proof),employeeDevice.privateKey).toString('base64url')}}});
  const employee=await session({uid:employeeUid,tenantId,device:employeeDevice});
  for(const payload of [entry('sale'),entry('returned',{kind:'sale_return',originalId:'sale',qtyMilli:2000,totalMinor:4000,paidMinor:1000}),payment('collection','merchant_payment',3000,{partyId:'merchant'}),entry('purchase',{kind:'purchase',partyId:'supplier',qtyMilli:5000,priceMinor:1000,totalMinor:5000,paidMinor:2000}),payment('supplier_paid','supplier_payment',1000,{partyId:'supplier'}),payment('expense','expense_business',700,{category:'Synthetic expense'}),payment('reverse_expense','reversal',0,{originalId:'expense',note:'Correct synthetic expense'})]){
   const first=await send(manager,payload.id,'entry',payload,1);assert.equal(first.status,'accepted');assert.deepEqual(await send(manager,payload.id,'entry',payload,2),first);
  }
  await send(manager,'salary','salary_term',{id:'salary',employeeId:'staff',effectiveMonth:'2026-10',monthlyMinor:100000,revision:1});
  await send(manager,'payroll','entry',payment('payroll','payroll',1000,{employeeId:'staff',salaryMonth:'2026-10'}));
  const submission={id:'submitted',tenantId,creatorUid:employeeUid,employeeId:'staff',kind:'delivery',date:'2026-10-18',partyId:'merchant',partyName:'',qtyMilli:1000,grade:'A',unit:'kg',originalId:'',amountMinor:0,note:''};
  assert.equal((await send(employee,'submitted','submission',submission)).status,'awaiting_approval');
  const review={id:'reviewed',submissionId:'submitted',decision:'approved',entry:entry('approved',{qtyMilli:1000,totalMinor:2000,paidMinor:0}),note:'Synthetic review'};
  const approvals=await Promise.all([send(manager,'reviewed','review',review),send(manager,'reviewed','review',review)]);assert.ok(approvals.every(x=>x.status==='accepted'),JSON.stringify(approvals));
  assert.equal((await send(employee,'pending','submission',{...submission,id:'pending'})).status,'awaiting_approval');
  await assert.rejects(send(employee,'forbidden','entry',entry('forbidden')),/permission-denied/);
  const root=db.doc('tenants/'+tenantId),rows=(await root.collection('entries').get()).docs.map(x=>x.data());
  const reversed=new Set(rows.filter(x=>x.kind==='reversal').map(x=>x.originalId)),active=rows.filter(x=>x.kind!=='reversal'&&!reversed.has(x.id));
  // Independent oracle: explicit business equations, no production report code.
  const merchantDebt=5000+20000-5000-4000+1000-3000+2000;
  const supplierDebt=3000+5000-2000-1000;
  const cash=active.reduce((n,e)=>n+(['sale','merchant_payment','purchase_return'].includes(e.kind)?e.paidMinor:-e.paidMinor),0);
  assert.equal(merchantDebt,16000);assert.equal(supplierDebt,5000);assert.equal(cash,3000);
  assert.equal(active.filter(e=>e.partyId==='merchant').reduce((n,e)=>n+(e.kind==='sale'?e.totalMinor-e.paidMinor:e.kind==='sale_return'?-e.totalMinor+e.paidMinor:-e.paidMinor),5000),merchantDebt);
  assert.equal((await root.collection('submissions').doc('pending').get()).data().status,'pending');
  const safe=await gateway.pullChanges(request(employee,{afterSequence:0,syncProtocolVersion:2}));assert.ok(safe.changes.every(c=>['party','submission'].includes(c.entity)));assert.equal(JSON.stringify(safe).includes('openingMinor'),false);assert.equal(JSON.stringify(safe).includes('priceMinor'),false);
  businesses.push({manager,employee,root,send});
 }
 await assert.rejects(gateway.pullChanges(request(businesses[0].manager,{tenantId:'campaign_b',afterSequence:0})),/permission-denied/);
 for(const b of businesses){await gateway.setMemberActive(request(b.manager,{uid:b.employee.uid,active:false}));await assert.rejects(gateway.pullChanges(request(b.employee,{afterSequence:0})),/permission-denied|reauthentication-required/);}
 const b=businesses[0],replacementDevice=device(),temporary=await mkdtemp(join(tmpdir(),'synthetic-transfer-'));
 try{
  const file=join(temporary,'request.json');await writeFile(file,JSON.stringify({tenantId:b.manager.tenantId,uid:b.manager.uid,deviceId:replacementDevice.deviceId,publicKeySpki:replacementDevice.publicKeySpki,revokeDeviceId:b.manager.device.deviceId}),{mode:0o600});
  execFileSync(process.execPath,['scripts/transfer-device.mjs',file,projectId],{env:process.env,stdio:'pipe'});
  const recovered=await session({...b.manager,sessionToken:undefined,device:replacementDevice});
  assert.equal(recovered.bootstrap.entitlement.trialEndMs,b.manager.bootstrap.entitlement.trialEndMs);
  await assert.rejects(gateway.pullChanges(request(b.manager,{afterSequence:0})),/permission-denied|reauthentication-required/);
  const page=await gateway.pullChanges(request(recovered,{afterSequence:0}));assert.ok(page.changes.some(c=>c.entity==='entry'&&c.id==='sale'));
  const original=entry('sale');const receipt=await b.send(recovered,'sale','entry',original);assert.equal(receipt.status,'accepted');
  assert.equal((await b.root.collection('entries').where('id','==','sale').get()).size,1);
 }finally{await rm(temporary,{recursive:true,force:true});}
});
