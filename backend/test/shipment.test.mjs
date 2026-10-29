/** Isolated emulator namespace: never clears project data or touches other fixtures. */
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign,randomBytes} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase-admin/app';import {getFirestore} from 'firebase-admin/firestore';import {getAuth} from 'firebase-admin/auth';
import {assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';
import {createGateway} from '../src/gateway.mjs';import {provisionTenant,issueEmployeeInvitation,acceptInvitation} from '../src/enrollment.mjs';import {canonical} from '../src/validation.mjs';
assertDemoOperatorEnvironment('demo-strawberry-flutter',process.env);
const suffix=randomBytes(6).toString('hex'),app=initializeApp({projectId:'demo-strawberry-flutter'},'shipment_'+suffix),db=getFirestore(app),auth=getAuth(app),issuer=generateKeyPairSync('ed25519');
const gateway=createGateway({db,auth,privateKey:()=>issuer.privateKey.export({format:'pem',type:'pkcs8'}),kid:()=> 'shipment-test-only'});
const tenant='shipment_'+suffix,other='other_shipment_'+suffix,uids=['ship_manager_'+suffix,'ship_other_'+suffix,'ship_employee_'+suffix];let a,b,e,invoiceBefore;
function device(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({format:'der',type:'spki'});return {...pair,deviceId:createHash('sha256').update(spki).digest('base64url'),publicKeySpki:spki.toString('base64url')};}
const req=(who,data)=>({auth:{uid:who.uid,token:{auth_time:Math.ceil(Date.now()/1000)+1}},data:{tenantId:who.tenantId,deviceId:who.device.deviceId,...(who.sessionToken?{sessionToken:who.sessionToken}:{}),...data}});
async function session(uid,tenantId,d){const who={uid,tenantId,device:d},c=await gateway.bootstrap(req(who,{})),r=await gateway.bootstrap(req(who,{challengeId:c.challengeId,signature:sign('sha256',Buffer.from(c.challenge),d.privateKey).toString('base64url')}));return {...who,sessionToken:r.sessionToken};}
const send=(who,id,entity,payload)=>gateway.syncOperation(req(who,{operation:{id,entity,payload,expectedRevision:0}}));
const sale=(id,extra={})=>({id,kind:'sale',date:'2026-10-18',partyId:'merchant',partyName:'ignored',qtyMilli:10000,priceMinor:2000,totalMinor:20000,paidMinor:5000,unit:'كجم',grade:'أول',note:'',...extra});
const update=(id,extra={})=>({id,kind:'shipment_update',date:'2026-10-19',originalId:'invoice',note:'تحديث موثق للشحنة',shipmentOrder:1,shipmentStatus:'in_transit',shipmentRef:'حملة ١',shippingEmployeeId:'staff',qtyMilli:0,priceMinor:0,totalMinor:0,paidMinor:0,partyId:'',partyName:'',grade:'',unit:'',employeeId:'',salaryMonth:'',category:'',adjustmentDirection:'',...extra});
before(async()=>{
 assertDemoOperatorEnvironment('demo-strawberry-flutter',process.env);
 for(const uid of uids)await auth.createUser({uid,email:uid+'@example.test',emailVerified:true,password:'Synthetic_only_7'});
 for(const [tenantId,uid]of [[tenant,uids[0]],[other,uids[1]]]){const d=device();await provisionTenant({db,auth,tenantId,uid,name:'اختبار شحن',deviceId:d.deviceId,publicKeySpki:d.publicKeySpki});const who=await session(uid,tenantId,d);if(tenantId===tenant)a=who;else b=who;}
 for(const who of [a,b])assert.equal((await send(who,'party','party',{id:'merchant',name:'عميل',kind:'merchant',openingMinor:0})).status,'accepted');
 for(const [id,active]of [['staff',true],['inactive_staff',false]])assert.equal((await send(a,id,'employee',{id,name:'مسؤول الشحن',active})).status,'accepted');
 assert.equal((await send(a,'invoice','entry',sale('invoice'))).status,'accepted');assert.equal((await send(b,'foreign_invoice','entry',sale('foreign_invoice'))).status,'accepted');invoiceBefore=(await db.doc(`tenants/${tenant}/entries/invoice`).get()).data();
 const d=device(),token=await issueEmployeeInvitation({db,auth,tenantId:tenant,uid:uids[2],employeeId:'staff'}),challenge=canonical({domain:'strawberry-accept-invitation-v1',tenantId:tenant,uid:uids[2],deviceId:d.deviceId,invitationToken:token});
 await acceptInvitation({db,auth,request:{auth:req({uid:uids[2],tenantId:tenant,device:d},{}).auth,data:{tenantId:tenant,deviceId:d.deviceId,publicKeySpki:d.publicKeySpki,invitationToken:token,signature:sign('sha256',Buffer.from(challenge),d.privateKey).toString('base64url')}}});e=await session(uids[2],tenant,d);
});
after(async()=>{assertDemoOperatorEnvironment('demo-strawberry-flutter',process.env);{for(const t of [tenant,other])await db.recursiveDelete(db.doc('tenants/'+t));for(const uid of uids)await auth.deleteUser(uid).catch(()=>{});}await deleteApp(app);});
test('shipment appends audited metadata without changing invoice financial facts',async()=>{
 assert.equal((await send(a,'shipment_one','entry',update('shipment_one'))).status,'accepted');assert.deepEqual((await db.doc(`tenants/${tenant}/entries/invoice`).get()).data(),invoiceBefore);
 const stored=(await db.doc(`tenants/${tenant}/entries/shipment_one`).get()).data();assert.equal(stored.creatorUid,a.uid);assert.equal(stored.originalId,'invoice');assert.equal(stored.shipmentStatus,'in_transit');assert.ok(['qtyMilli','priceMinor','totalMinor','paidMinor'].every(k=>stored[k]===0));assert.equal(stored.partyId,'');assert.equal((await db.doc(`tenants/${tenant}/audit/shipment_one`).get()).data().entity,'entry');
});
test('concurrent duplicate shipment delivery creates one effect',async()=>{
 const event=update('shipment_duplicate',{shipmentOrder:2,shipmentStatus:'delivered'}),results=await Promise.all(Array.from({length:4},()=>send(a,'shipment_duplicate','entry',event)));assert.ok(results.every(x=>x.status==='accepted'));assert.ok(results.every(x=>x.sequence===results[0].sequence));assert.equal((await db.collection(`tenants/${tenant}/audit`).where('operationId','==','shipment_duplicate').get()).size,1);assert.equal((await send(a,'shipment_duplicate','entry',{...event,shipmentRef:'different'})).reason,'operation-id-reused');
});
test('shipment cannot smuggle financial, counterparty or payroll effects',async()=>{
 for(const [field,value]of [['totalMinor',100],['paidMinor',100],['qtyMilli',100],['partyId','merchant'],['employeeId','staff']])assert.equal((await send(a,'bad_'+field,'entry',update('bad_'+field,{[field]:value}))).status,'conflict');assert.deepEqual((await db.doc(`tenants/${tenant}/entries/invoice`).get()).data(),invoiceBefore);
});
test('shipment invoice and active assignee are tenant scoped',async()=>{
 assert.equal((await send(a,'foreign_original','entry',update('foreign_original',{originalId:'foreign_invoice'}))).reason,'shipment-original-mismatch');assert.equal((await send(b,'wrong_tenant_invoice','entry',update('wrong_tenant_invoice',{shippingEmployeeId:''}))).reason,'shipment-original-mismatch');
 assert.equal((await send(a,'missing_staff','entry',update('missing_staff',{shippingEmployeeId:'foreign_staff'}))).reason,'missing-employee');assert.equal((await send(a,'inactive_staff_event','entry',update('inactive_staff_event',{shippingEmployeeId:'inactive_staff'}))).reason,'missing-employee');assert.equal((await send(a,'not_invoice','entry',update('not_invoice',{originalId:'shipment_one'}))).reason,'shipment-original-mismatch');assert.equal((await send(a,'before_invoice','entry',update('before_invoice',{date:'2026-10-17'}))).reason,'shipment-original-mismatch');
});
test('employee cannot forge shipment entry',async()=>{await assert.rejects(send(e,'employee_forgery','entry',update('employee_forgery')),/permission-denied/);assert.equal((await db.doc(`tenants/${tenant}/entries/employee_forgery`).get()).exists,false);});
test('reversed invoices deny shipment updates; metadata corrections append another event',async()=>{
 assert.equal((await send(a,'void_invoice','entry',sale('void_invoice'))).status,'accepted');const reverse={id:'reverse_void',kind:'reversal',date:'2026-10-19',originalId:'void_invoice',note:'تصحيح الفاتورة',qtyMilli:0,priceMinor:0,totalMinor:0,paidMinor:0};assert.equal((await send(a,'reverse_void','entry',reverse)).status,'accepted');assert.equal((await send(a,'update_void','entry',update('update_void',{originalId:'void_invoice'}))).reason,'shipment-original-mismatch');assert.equal((await send(a,'reverse_metadata','entry',{...reverse,id:'reverse_metadata',originalId:'shipment_one'})).reason,'reversal-not-allowed');assert.equal((await send(a,'shipment_correction','entry',update('shipment_correction',{shipmentOrder:3,shipmentStatus:'pending',shippingEmployeeId:'',shipmentRef:''}))).status,'accepted');assert.equal((await db.doc(`tenants/${tenant}/entries/shipment_one`).get()).exists,true);
});

test('concurrent distinct same-order updates preserve conflict and advance once',async()=>{
 const [x,y]=await Promise.all([send(a,'concurrent_one','entry',update('concurrent_one',{shipmentOrder:4})),send(a,'concurrent_two','entry',update('concurrent_two',{shipmentOrder:4,shipmentRef:'alternative'}))]);assert.equal([x,y].filter(x=>x.status==='accepted').length,1);assert.equal([x,y].filter(x=>x.reason==='shipment-order-conflict').length,1);const counter=(await db.doc(`tenants/${tenant}/shipmentCounters/invoice`).get()).data();assert.equal(counter.order,4);
 const accepted=x.status==='accepted'?'concurrent_one':'concurrent_two',event=update(accepted,{shipmentOrder:4,...(accepted==='concurrent_two'?{shipmentRef:'alternative'}:{})});assert.equal((await send(a,accepted,'entry',event)).status,'accepted');assert.equal((await db.doc(`tenants/${tenant}/shipmentCounters/invoice`).get()).data().order,4);
 const denied=x.status==='conflict'?'concurrent_one':'concurrent_two';assert.equal((await db.doc(`tenants/${tenant}/conflicts/${denied}`).get()).data().reason,'shipment-order-conflict');assert.equal((await db.doc(`tenants/${tenant}/entries/${denied}`).get()).exists,false);
});
