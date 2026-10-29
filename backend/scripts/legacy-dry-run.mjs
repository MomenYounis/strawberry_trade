/** Read-only conversion and reconciliation. No Firebase/Admin imports or remote writes. */
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {entry,directory,amount,id,object,integer} from '../src/validation.mjs';

export function scaled(value,places){
 const s=String(value??0);if(!/^-?\d+(\.\d+)?$/.test(s))throw Error('not-finite-decimal');
 const [whole,fraction='']=s.split('.');if(fraction.length>places)throw Error('precision-needs-review');
 const negative=whole.startsWith('-'),n=BigInt(whole.replace('-',''))*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
 const result=Number(negative?-n:n);if(!Number.isSafeInteger(result))throw Error('unsafe-number');return result;
}
const ordered=rows=>[...rows].sort((a,b)=>String(a?.date).localeCompare(String(b?.date))||Number(String(a?.type).endsWith('_return'))-Number(String(b?.type).endsWith('_return'))||String(a?.id).localeCompare(String(b?.id)));
const sortedObject=map=>Object.fromEntries([...map].sort(([a],[b])=>a.localeCompare(b)));
function controls(parties,entries){
 const balances=new Map(parties.map(p=>[p.id,BigInt(p.openingMinor)])),totals=new Map(),counts=new Map();let cash=0n;
 for(const e of entries){
  const value=BigInt(e.totalMinor),paid=BigInt(e.paidMinor);totals.set(e.kind,(totals.get(e.kind)||0n)+value);counts.set(e.kind,(counts.get(e.kind)||0)+1);
  const effect=['sale','purchase'].includes(e.kind)?value-paid:['merchant_payment','supplier_payment'].includes(e.kind)?-paid:['sale_return','purchase_return'].includes(e.kind)?-value+paid:0n;
  if(e.partyId)balances.set(e.partyId,(balances.get(e.partyId)||0n)+effect);
  cash+=['sale','merchant_payment','purchase_return'].includes(e.kind)?paid:['purchase','supplier_payment','sale_return'].includes(e.kind)?-paid:['expense_business','expense_home','payroll'].includes(e.kind)?-value:0n;
 }
 // Decimal strings preserve arbitrarily large aggregate sums without JS rounding.
 return {partyBalanceMinor:sortedObject(new Map([...balances].map(([k,v])=>[k,String(v)]))),totalMinorByKind:sortedObject(new Map([...totals].map(([k,v])=>[k,String(v)]))),countByKind:sortedObject(counts),netRecordedCashMinor:String(cash)};
}
export function dryRun(data,tenantId){
 id(tenantId);object(data);if(!Array.isArray(data.merchants)||!Array.isArray(data.suppliers)||!Array.isArray(data.transactions)||!Array.isArray(data.employees??[]))throw Error('invalid-backup');
 const result={version:2,tenantId,productionWrites:0,parties:[],employees:[],salaryTerms:[],entries:[],issues:[],legacySalaryEvidence:[],legacyProvenance:[],metadata:{businessMonthlyBudget:data.businessMonthlyBudget??null}},seenDirectory=new Set(),seenEntries=new Set(),parties=new Map(),employees=new Set(),invoices=new Map(),counters=new Map();
 const issue=(type,record,error,severity='quarantine')=>result.issues.push({type,id:record?.id??null,severity,reason:error.message||String(error),original:record});
 for(const [kind,list]of [['merchant',data.merchants],['supplier',data.suppliers]])for(const p of list){try{
  object(p);if(seenDirectory.has(p.id))throw Error('duplicate-directory-id');seenDirectory.add(p.id);
  const value=directory('party',{id:p.id,tenantId,name:p.name,kind,phone:p.phone||'',openingMinor:scaled(p.openingBalance,2),favorite:false,revision:1},tenantId);
  result.parties.push(value);parties.set(p.id,value);
 }catch(e){issue('party',p,e);}}
 for(const e of data.employees||[]){try{
  object(e);if(seenDirectory.has(e.id))throw Error('duplicate-directory-id');seenDirectory.add(e.id);
  if(e.monthlySalary!==undefined)integer(scaled(e.monthlySalary,2));
  result.employees.push(directory('employee',{id:e.id,tenantId,name:e.name,phone:e.phone||'',active:e.active!==false,revision:1},tenantId));employees.add(e.id);
  result.legacySalaryEvidence.push({employeeId:e.id,currentMonthlySalary:e.monthlySalary??null,role:e.role||'',effectiveMonth:null});
 }catch(error){issue('employee',e,error);}}
 for(const t of ordered(data.transactions)){try{
  object(t);if(seenEntries.has(t.id))throw Error('duplicate-transaction-id');seenEntries.add(t.id);
  const kind=t.employeeId&&t.type==='expense_business'&&t.category==='رواتب وأجور'?'payroll':t.type,party=parties.get(t.partyId),financial=['sale','purchase','sale_return','purchase_return'].includes(kind),payment=['merchant_payment','supplier_payment'].includes(kind),total=scaled(payment?t.paidAmount:t.totalAmount,2);
  const v={id:t.id,tenantId,creatorUid:t.recordedByUid||'legacy_import',kind,date:t.date,partyId:party?.id||'',partyName:party?.name||'',qtyMilli:financial?scaled(t.qty,3):0,priceMinor:financial?scaled(t.unitPrice,2):0,totalMinor:total,paidMinor:financial?scaled(t.paidAmount,2):total,unit:financial?t.unit||'':'',grade:financial?t.grade||'':'',originalId:t.originalTransactionId||'',employeeId:kind==='payroll'?t.employeeId:'',salaryMonth:kind==='payroll'?t.salaryMonth:'',note:t.note||'',category:['expense_business','expense_home','payroll'].includes(kind)?t.category||'مصاريف أخرى':'',shippingEmployeeId:t.shippingEmployeeId==='unassigned'?'':t.shippingEmployeeId||'',shipmentRef:t.shipmentRef||'',shipmentStatus:t.shipmentStatus||'',adjustmentDirection:'',revision:1};
  id(v.creatorUid);entry(v,{allowReturnResidual:kind.endsWith('_return')});
  if(financial||payment){if(!party)throw Error('missing-party');if(party.kind!==(['purchase','purchase_return','supplier_payment'].includes(kind)?'supplier':'merchant'))throw Error('wrong-party-kind');}
  if((v.shippingEmployeeId||v.shipmentRef||v.shipmentStatus)&&!['sale','purchase'].includes(kind))throw Error('invalid-shipment');
  if(v.shippingEmployeeId&&!employees.has(v.shippingEmployeeId))throw Error('missing-shipping-employee');
  if(t.employeeId&&kind!=='payroll')throw Error('unexpected-payroll-recipient');
  if(t.salaryMonth&&kind!=='payroll')throw Error('unexpected-salary-month');
  if(kind==='payroll'&&!employees.has(v.employeeId))throw Error('missing-employee');
  if(kind.endsWith('_return')){
   const orig=invoices.get(v.originalId),c=counters.get(v.originalId)||{qtyMilli:0,totalMinor:0};
   if(!orig||orig.kind!==(kind==='sale_return'?'sale':'purchase')||orig.partyId!==v.partyId||orig.unit!==v.unit||orig.grade!==v.grade||orig.priceMinor!==v.priceMinor||v.date<orig.date)throw Error('return-original-mismatch');
   const q=c.qtyMilli+v.qtyMilli;if(q>orig.qtyMilli)throw Error('return-exceeded');
   const required=q===orig.qtyMilli?orig.totalMinor-c.totalMinor:amount(q,orig.priceMinor)-c.totalMinor;
   if(required<=0||v.totalMinor!==required)throw Error('return-rounding-needs-review');counters.set(v.originalId,{qtyMilli:q,totalMinor:c.totalMinor+v.totalMinor});
  }
  if(['sale','purchase'].includes(kind))invoices.set(v.id,v);
  if(kind==='payroll')issue('salary-history',t,Error('historical-effective-salary-not-known'),'needs-evidence');
  result.entries.push(v);
  result.legacyProvenance.push({entryId:v.id,recordedByUid:t.recordedByUid??null,recordedByEmployeeId:t.recordedByEmployeeId??null,recordedByName:t.recordedByName??null,recordedAt:t.recordedAt??null,submissionId:t.submissionId??null,createdAt:t.createdAt??null});
 }catch(error){issue('transaction',t,error);}}
 result.returnCounters=sortedObject(counters);
 result.controls=controls(result.parties,result.entries);
 result.counts={sourceParties:data.merchants.length+data.suppliers.length,sourceEmployees:(data.employees||[]).length,sourceTransactions:data.transactions.length,candidateParties:result.parties.length,candidateEmployees:result.employees.length,candidateEntries:result.entries.length,quarantined:result.issues.filter(x=>x.severity==='quarantine').length,needsEvidence:result.issues.filter(x=>x.severity==='needs-evidence').length};
 result.readyToMigrate=result.issues.length===0;
 result.warning='Review artifact only. Not an app backup or an executable production migration. Quarantined records and historical salary evidence must be resolved; issue accounts/membership separately through trusted enrollment.';
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,tenantId,output]=process.argv.slice(2);if(!input||!tenantId||!output)throw Error('Usage: legacy-dry-run.mjs BACKUP.json TENANT_ID REPORT.json');
 const bytes=await readFile(input);if(bytes.length>25*1024*1024)throw Error('backup-too-large');
 const report=dryRun(JSON.parse(bytes),tenantId);report.sourceSha256=createHash('sha256').update(bytes).digest('hex');
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report.counts));
}
