import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';
import {entry,amount,directory,signed,verifySigned,canonical} from '../src/validation.mjs';import {entitled,TRIAL_MS} from '../src/gateway.mjs';
const sale={id:'i1',kind:'sale',date:'2026-10-18',partyId:'p1',partyName:'عميل',qtyMilli:10000,priceMinor:2000,totalMinor:20000,paidMinor:5000,unit:'كجم',grade:'أول',note:''};
test('integer half-up quantity and money reference',()=>{assert.equal(amount(1234,12345),15234);assert.equal(amount(5,100),1);assert.equal(amount(10000,2000),20000);});
test('invalid imports cannot disagree total or overpay',()=>{assert.throws(()=>entry({...sale,totalMinor:100,paidMinor:50000}));assert.throws(()=>entry({...sale,totalMinor:1,paidMinor:0}),/invalid-total/);});
test('all financial boundaries reject NaN infinity strings negative and fractional',()=>{for(const v of [NaN,Infinity,'3',-1,0.1])assert.throws(()=>entry({...sale,qtyMilli:v}));assert.throws(()=>entry({...sale,unit:'x'.repeat(41)}));assert.throws(()=>entry({...sale,unknown:1}));});
test('real ISO date validation',()=>{assert.throws(()=>entry({...sale,date:'2026-02-30'}));assert.equal(entry(sale).date,'2026-10-18');});
test('directory signed opening and tenant checks',()=>{assert.equal(directory('party',{id:'p',name:'عميل',kind:'merchant',openingMinor:-100},'t').openingMinor,-100);assert.throws(()=>directory('party',{id:'p',name:'عميل',kind:'merchant',tenantId:'other'},'t'));});
test('30x24 trial with exact shared boundary independent of employee join time',()=>{const start=1792281600000,t={enabled:true,trialStartMs:start,trialEndMs:start+TRIAL_MS};assert.equal(TRIAL_MS,2592000000);assert.equal(entitled(t,start+29*86400000),true);assert.equal(entitled(t,start+TRIAL_MS-1),true);assert.equal(entitled(t,start+TRIAL_MS),false);});
test('signed canonical UTF8 package detects tampering',()=>{const {privateKey,publicKey}=generateKeyPairSync('ed25519'),pub=publicKey.export({type:'spki',format:'pem'});const x={tenantId:'t',name:'عربي',expiresAtMs:null,epoch:2};const env=signed(x,privateKey,'test');assert.deepEqual(verifySigned(env,pub),x);assert.throws(()=>verifySigned({...env,payload:Buffer.from(canonical({...x,epoch:3})).toString('base64url')},pub));});

test('paid expiry overrides remaining original trial',()=>{const t={enabled:true,trialEndMs:100000,entitlementPayload:{expiresAtMs:1000}};assert.equal(entitled(t,999),true);assert.equal(entitled(t,1000),false);});
import {dryRun} from '../scripts/legacy-dry-run.mjs';
test('migration dry-run quarantines legacy inconsistent totals, grade mismatch, non-lossless price',()=>{const data={merchants:[{id:'p',name:'عميل',openingBalance:0}],suppliers:[],transactions:[{id:'bad',type:'sale',partyId:'p',date:'2026-10-18',qty:10,unitPrice:20,totalAmount:1,paidAmount:500,unit:'كجم',grade:'أول'},{id:'precise',type:'sale',partyId:'p',date:'2026-10-18',qty:3,unitPrice:0.3333,totalAmount:1,paidAmount:0,unit:'كجم',grade:'أول'}]};const r=dryRun(data,'tenant');assert.equal(r.productionWrites,0);assert.equal(r.readyToMigrate,false);assert.equal(r.counts.quarantined,2);assert.ok(r.issues.some(x=>x.reason==='precision-needs-review'));});

test('documented debt adjustment has no cash effect and explicit direction',()=>{
 const adjustment={id:'adjust',kind:'balance_adjustment',date:'2026-10-18',partyId:'p1',partyName:'عميل',qtyMilli:0,priceMinor:0,totalMinor:1000,paidMinor:0,note:'تصحيح مثبت بالمستند',adjustmentDirection:'increase'};
 assert.equal(entry(adjustment).totalMinor,1000);
 for(const extra of [{paidMinor:1000},{adjustmentDirection:'other'},{note:''},{partyId:''},{totalMinor:0},{grade:'أول'}])assert.throws(()=>entry({...adjustment,...extra}));
 assert.throws(()=>entry({...sale,adjustmentDirection:'increase'}));
});
test('expense category defaults and unrelated kinds cannot carry an expense category',()=>{
 const e={id:'e',kind:'expense_business',date:'2026-10-18',totalMinor:100,paidMinor:100};assert.equal(entry(e).category,'مصاريف أخرى');
 assert.equal(entry({...e,category:'مواصلات'}).category,'مواصلات');assert.throws(()=>entry({...sale,category:'مواصلات'}));
});
const migrationBase=()=>({merchants:[{id:'p',name:'عميل',openingBalance:10}],suppliers:[{id:'s',name:'مورد',openingBalance:5}],employees:[],transactions:[]});
const legacyInvoice=(extra={})=>({id:'z_invoice',type:'sale',partyId:'p',date:'2026-10-18',qty:10,unitPrice:20,totalAmount:200,paidAmount:50,unit:'كجم',grade:'أول',...extra});
test('migration keeps identifiers, same-day relationships, provenance and known control balances',()=>{
 const data=migrationBase();data.transactions=[legacyInvoice({id:'a_return',type:'sale_return',originalTransactionId:'z_invoice',qty:2,totalAmount:40,paidAmount:10}),legacyInvoice({recordedByUid:'old_employee',submissionId:'old_submission'}),{id:'collection',type:'merchant_payment',partyId:'p',date:'2026-10-19',paidAmount:20}];
 const r=dryRun(data,'tenant');assert.equal(r.readyToMigrate,true);assert.deepEqual(r.entries.map(x=>x.id),['z_invoice','a_return','collection']);assert.equal(r.entries[0].creatorUid,'old_employee');assert.equal(r.legacyProvenance[0].submissionId,'old_submission');
 assert.equal(r.controls.partyBalanceMinor.p,'11000');assert.equal(r.controls.partyBalanceMinor.s,'500');assert.equal(r.controls.netRecordedCashMinor,'6000');assert.deepEqual(r.returnCounters.z_invoice,{qtyMilli:2000,totalMinor:4000});
});
test('migration quarantines unit and grade mismatches, unknown shipping employees and wrong party kind',()=>{
 const data=migrationBase();data.transactions=[legacyInvoice(),legacyInvoice({id:'wrong_unit',type:'sale_return',originalTransactionId:'z_invoice',qty:1,totalAmount:20,paidAmount:0,unit:'صندوق'}),legacyInvoice({id:'wrong_grade',type:'sale_return',originalTransactionId:'z_invoice',qty:1,totalAmount:20,paidAmount:0,grade:'ثان'}),legacyInvoice({id:'wrong_party',partyId:'s'}),legacyInvoice({id:'shipment',shippingEmployeeId:'missing'})];
 const r=dryRun(data,'tenant');assert.equal(r.counts.quarantined,4);assert.ok(r.issues.some(x=>x.reason==='missing-shipping-employee'));assert.ok(r.issues.some(x=>x.reason==='wrong-party-kind'));assert.equal(r.entries.length,1);
});
test('migration preserves payroll payment but blocks readiness until historical salary is evidenced',()=>{
 const data=migrationBase();data.employees=[{id:'staff',name:'موظف',monthlySalary:3000}];data.transactions=[{id:'salary',type:'expense_business',category:'رواتب وأجور',employeeId:'staff',salaryMonth:'2026-10',date:'2026-10-18',totalAmount:1000}];
 const r=dryRun(data,'tenant');assert.equal(r.entries[0].kind,'payroll');assert.equal(r.entries[0].employeeId,'staff');assert.equal(r.counts.needsEvidence,1);assert.equal(r.readyToMigrate,false);assert.equal(r.salaryTerms.length,0);assert.equal(r.legacySalaryEvidence[0].effectiveMonth,null);
});

test('shipment metadata events require zero financial fields, active-invoice reference, status and documented reason',()=>{
 const update={id:'shipping_event',kind:'shipment_update',date:'2026-10-18',originalId:'invoice_a',note:'تغيير مسؤول الشحنة',shipmentOrder:1,shipmentStatus:'in_transit',shipmentRef:'حملة ١',shippingEmployeeId:'staff_a',qtyMilli:0,priceMinor:0,totalMinor:0,paidMinor:0,partyId:'',partyName:'',grade:'',unit:'',employeeId:'',salaryMonth:'',category:'',adjustmentDirection:''};
 assert.equal(entry(update).kind,'shipment_update');assert.throws(()=>entry({...sale,shipmentOrder:1}));
 for(const extra of [{shipmentOrder:0},{shipmentOrder:-1},{shipmentOrder:1.5},{totalMinor:1},{paidMinor:1},{qtyMilli:1},{priceMinor:1},{partyId:'p1'},{partyName:'طرف'},{employeeId:'staff_a'},{salaryMonth:'2026-10'},{grade:'أول'},{unit:'كجم'},{note:''},{originalId:''},{shipmentStatus:''},{shipmentStatus:'unknown'},{category:'مصروف'},{adjustmentDirection:'increase'}])assert.throws(()=>entry({...update,...extra}));
});
