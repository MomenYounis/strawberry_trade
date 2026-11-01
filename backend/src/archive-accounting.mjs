import {createHash} from 'node:crypto';
import {canonical,entry,directory,id,integer,isoDate} from './validation.mjs';
import {annualInterval,financialYearForDate} from './archive-calendar.mjs';

// Archive identity and controls must not depend on the host ICU locale.
const compareCodeUnits=(a,b)=>a<b?-1:a>b?1:0;

const MAX_ACCOUNTS=10_000,MAX_IDENTITIES=500_000;
const number=(v)=>integer(v,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
const sum=(a,b)=>{const result=BigInt(number(a))+BigInt(number(b));if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(-Number.MAX_SAFE_INTEGER))throw new Error('archive-integer-overflow');return Number(result);};
function allowed(v,fields){if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!fields.includes(k)))throw new Error('invalid-archive-record');}
function strictEntry(payload){
  // submittedByEmployeeId is added by the trusted gateway after entry validation.
  const {submittedByEmployeeId,originalBusinessDate,correctionOfOperationId,...fields}=payload??{};
  if(submittedByEmployeeId!==undefined)id(submittedByEmployeeId);
  if((originalBusinessDate===undefined)!==(correctionOfOperationId===undefined))throw new Error('invalid-correction-reference');
  if(originalBusinessDate!==undefined){isoDate(originalBusinessDate);id(correctionOfOperationId);if(originalBusinessDate>=fields.date)throw new Error('invalid-correction-reference');}
  return {...entry(fields,{allowReturnResidual:true}),...(submittedByEmployeeId?{submittedByEmployeeId}:{}),...(originalBusinessDate?{originalBusinessDate,correctionOfOperationId}:{})};
}
export function validateArchiveRecord(record,context) {
  allowed(record,['type','tenantId','year','sequence','payload']);
  if(record.tenantId!==context.tenantId||record.year!==context.year)throw new Error('mixed-tenant-or-year');
  integer(record.sequence,0,context.closingSequence);
  const p=record.payload;
  if(record.type==='opening') {
    allowed(p,['id','role','balanceMinor']);id(p.id);number(p.balanceMinor);
    if(!['merchant','supplier','cash_movement','payroll_paid'].includes(p.role)||record.sequence!==0)throw new Error('invalid-opening-baseline');
  } else if(record.type==='entry'||record.type==='reference') {
    strictEntry(p);if(p.tenantId!==context.tenantId)throw new Error('mixed-tenant-or-year');
    if(record.sequence<1)throw new Error('invalid-entry-sequence');
    isoDate(p.date);
    if(record.type==='entry'&&financialYearForDate(p.date)!==context.year)throw new Error('mixed-tenant-or-year');
    if(record.type==='reference'&&(p.date>=annualInterval(context.year).startDate||['reversal','shipment_update'].includes(p.kind)))throw new Error('invalid-historical-reference');
  } else if(record.type==='snapshot') {
    allowed(p,['id','entity','record']);id(p.id);
    if(!p.record||p.record.id!==p.id||p.record.tenantId!==context.tenantId||record.sequence<1)throw new Error('invalid-reference-snapshot');
    if(['party','employee','salary_term'].includes(p.entity))directory(p.entity,p.record,context.tenantId);
    else if(p.entity==='submission') {
      allowed(p.record,['id','tenantId','creatorUid','employeeId','kind','date','partyId','partyName','qtyMilli','grade','unit','originalId','amountMinor','note','category','status','recordedByUid','recordedAtMs','approvedUnitMinor','reviewNote']);
      isoDate(p.record.date);id(p.record.employeeId);id(p.record.creatorUid);id(p.record.recordedByUid);
      integer(p.record.recordedAtMs,0,8_640_000_000_000_000);
      if(!['pending','approved','rejected'].includes(p.record.status)||!['delivery','purchase_delivery','sale_return','purchase_return','expense_business'].includes(p.record.kind))throw new Error('invalid-submission-snapshot');
      for(const key of ['qtyMilli','amountMinor','approvedUnitMinor'])if(p.record[key]!==undefined)integer(p.record[key]);
    } else if(p.entity==='review') {
      allowed(p.record,['id','tenantId','submissionId','decision','note','reviewerUid','reviewedAtMs','entryId']);id(p.record.submissionId);id(p.record.reviewerUid);integer(p.record.reviewedAtMs,0,8_640_000_000_000_000);
      if(!['approved','rejected'].includes(p.record.decision))throw new Error('invalid-review-snapshot');
      if(p.record.entryId)id(p.record.entryId);
    } else throw new Error('unsupported-reference-snapshot');
  } else throw new Error('unsupported-archive-record-type');
  return record;
}

function effects(e,roleFor) {
  const cash=['sale','merchant_payment','purchase_return'].includes(e.kind)?e.paidMinor??0:-(e.paidMinor??0);
  let party=0,role=null;
  if(['sale','purchase'].includes(e.kind))party=e.totalMinor-e.paidMinor;
  else if(['sale_return','purchase_return'].includes(e.kind))party=-e.totalMinor+e.paidMinor;
  else if(['merchant_payment','supplier_payment'].includes(e.kind))party=-e.paidMinor;
  else if(e.kind==='balance_adjustment')party=e.adjustmentDirection==='increase'?e.totalMinor:-e.totalMinor;
  if(e.partyId&&party!==0) {
    role=['purchase','purchase_return','supplier_payment'].includes(e.kind)?'supplier':
      ['sale','sale_return','merchant_payment'].includes(e.kind)?'merchant':roleFor(e.partyId);
    if(!role)throw new Error('party-baseline-required');
  }
  return {cash,party,role,partyId:e.partyId,payroll:e.kind==='payroll'?e.paidMinor:0,
    payrollId:e.kind==='payroll'?`${e.employeeId}_${e.salaryMonth}`:null,
    kind:e.kind,totalMinor:e.totalMinor??0,paidMinor:e.paidMinor??0,qtyMilli:e.qtyMilli??0};
}

// Streaming bounded accounting control reader. Retains only small effects for
// reversal references and identity checks, never complete yearly payloads.
// Opening rows must precede entries, and references precede their reversal.
export class ArchiveControlReader {
  constructor(context){this.context=context;this.identities=new Set();this.ids=new Set();this.effectById=new Map();this.accounts=new Map();this.reversed=new Set();this.periodTotals={};this.counts={opening:0,entry:0,reference:0,snapshot:0};this.sourceHash=createHash('sha256');this.cashPeriod=0;this.cashOpening=0;this.lastSequence=0;this.entriesStarted=false;this.snapshotCounts={};this.pendingSubmissions=0;this.salaryTerms=[];}
  accept(record){
    validateArchiveRecord(record,this.context);
    const p=record.payload,key=`${record.type}/${record.type==='opening'?p.role+'/':record.type==='snapshot'?p.entity+'/':''}${p.id}`;
    if(this.identities.has(key))throw new Error('duplicate-archive-record');
    if(this.identities.size>=MAX_IDENTITIES)throw new Error('archive-identity-limit');
    this.identities.add(key);this.counts[record.type]++;this.sourceHash.update(canonical(record)+'\n');
    if(record.type==='snapshot') {
      if(this.entriesStarted)throw new Error('snapshot-after-entry');
      this.snapshotCounts[p.entity]=(this.snapshotCounts[p.entity]??0)+1;
      if(p.entity==='submission'&&p.record.status==='pending')this.pendingSubmissions++;
      if(p.entity==='salary_term'){if(this.salaryTerms.length>=10_000)throw new Error('salary-term-limit');this.salaryTerms.push(p.record);}
      return;
    }
    if(record.type==='opening') {
      if(this.entriesStarted)throw new Error('opening-after-entry');
      const account=`${p.role}/${p.id}`;
      if(this.accounts.has(account))throw new Error('duplicate-opening-baseline');
      if(this.accounts.size>=MAX_ACCOUNTS)throw new Error('archive-account-limit');
      this.accounts.set(account,{role:p.role,id:p.id,openingMinor:p.balanceMinor,periodMinor:0,closingMinor:p.balanceMinor});
      if(p.role==='cash_movement'){if(p.id!=='recorded_net')throw new Error('invalid-cash-baseline');this.cashOpening=p.balanceMinor;}
      return;
    }
    this.entriesStarted=true;
    if(this.ids.has(p.id))throw new Error('duplicate-entry-identity');
    this.ids.add(p.id);
    const roleFor=partyId=>{
      const roles=['merchant','supplier'].filter(role=>this.accounts.has(`${role}/${partyId}`));
      if(roles.length!==1)throw new Error('ambiguous-party-role');return roles[0];
    };
    if(record.type==='reference'){this.effectById.set(p.id,effects(p,roleFor));return;}
    if(record.sequence<=this.lastSequence)throw new Error('entry-sequence-order');
    this.lastSequence=record.sequence;
    let effect,sign=1;
    if(p.kind==='reversal') {
      effect=this.effectById.get(p.originalId);
      if(!effect||this.reversed.has(p.originalId))throw new Error('missing-or-duplicate-reversal-reference');
      this.reversed.add(p.originalId);sign=-1;
    } else {effect=effects(p,roleFor);this.effectById.set(p.id,effect);}
    this.cashPeriod=sum(this.cashPeriod,sign*effect.cash);
    const totals=this.periodTotals[effect.kind]??={totalMinor:0,paidMinor:0,qtyMilli:0};
    for(const field of ['totalMinor','paidMinor','qtyMilli'])totals[field]=sum(totals[field],sign*effect[field]);
    for(const [role,partyId,delta] of [[effect.role,effect.partyId,sign*effect.party],['payroll_paid',effect.payrollId,sign*effect.payroll]])if(delta!==0) {
      const account=this.accounts.get(`${role}/${partyId}`);if(!account)throw new Error('account-opening-required');
      account.periodMinor=sum(account.periodMinor,delta);account.closingMinor=sum(account.openingMinor,account.periodMinor);
    }
  }
  finish(){
    if(!this.accounts.has('cash_movement/recorded_net'))throw new Error('cash-movement-baseline-required');
    const accounts=[...this.accounts.values()].sort((a,b)=>compareCodeUnits(`${a.role}/${a.id}`,`${b.role}/${b.id}`));
    for(const account of accounts)if(account.role==='cash_movement'){account.periodMinor=this.cashPeriod;account.closingMinor=sum(this.cashOpening,this.cashPeriod);}
    const total=role=>accounts.filter(a=>a.role===role).reduce((n,a)=>sum(n,a.closingMinor),0);
    const payrollObligations=[],unknownPayrollMonths=[],endMonth=`${this.context.year+1}-08`;
    const employees=[...new Set(this.salaryTerms.map(t=>t.employeeId))].sort(compareCodeUnits);
    for(const employeeId of employees){
      const terms=this.salaryTerms.filter(t=>t.employeeId===employeeId).sort((a,b)=>compareCodeUnits(a.effectiveMonth,b.effectiveMonth));
      if(new Set(terms.map(t=>t.effectiveMonth)).size!==terms.length)throw new Error('duplicate-salary-effective-month');
      let month=terms[0].effectiveMonth,index=0;
      while(month<=endMonth){
        if(payrollObligations.length>=20_000)throw new Error('payroll-month-limit');
        while(index+1<terms.length&&terms[index+1].effectiveMonth<=month)index++;
        const paidMinor=this.accounts.get(`payroll_paid/${employeeId}_${month}`)?.closingMinor??0;
        payrollObligations.push({employeeId,salaryMonth:month,entitlementMinor:terms[index].monthlyMinor,paidMinor,balanceMinor:sum(terms[index].monthlyMinor,-paidMinor)});
        const [year,m]=month.split('-').map(Number);month=m===12?`${year+1}-01`:`${year}-${String(m+1).padStart(2,'0')}`;
      }
    }
    for(const account of accounts.filter(a=>a.role==='payroll_paid')){
      const month=account.id.slice(-7),employeeId=account.id.slice(0,-8);
      if(!this.salaryTerms.some(t=>t.employeeId===employeeId&&t.effectiveMonth<=month))unknownPayrollMonths.push({employeeId,salaryMonth:month});
    }
    return {counts:{...this.counts},identitySha256:this.sourceHash.copy().digest('hex'),accounts,periodTotals:structuredClone(this.periodTotals),snapshotCounts:{...this.snapshotCounts},pendingSubmissions:this.pendingSubmissions,payrollObligations,unknownPayrollMonths,
      signedReceivablesMinor:total('merchant'),signedPayablesMinor:total('supplier'),
      periodRecordedCashMinor:this.cashPeriod,cumulativeRecordedCashMinor:sum(this.cashOpening,this.cashPeriod)};
  }
}

// Actual model: each accepted operation appends immutable change payloads and
// updates root.sequence in one transaction. No read of mutable submissions is a
// historical snapshot. Query each bounded page at <= the captured sequence.
export async function* immutableChangesAtCheckpoint(db,{tenantId,sequence,pageSize=100,maxPages=10_000}) {
  id(tenantId);integer(sequence,0,Number.MAX_SAFE_INTEGER);integer(pageSize,1,250);integer(maxPages,1,10_000);
  let after=0;
  for(let page=0;page<maxPages;page++) {
    const result=await db.doc(`tenants/${tenantId}`).collection('changes').where('sequence','>',after)
      .where('sequence','<=',sequence).orderBy('sequence').limit(pageSize).get();
    if(!result.docs.length){if(after!==sequence)throw new Error('checkpoint-history-gap');return;}
    for(const doc of result.docs){const change=doc.data();if(change.sequence!==after+1||change.sequence>sequence)throw new Error('checkpoint-history-gap');after=change.sequence;yield change;}
    if(after===sequence)return;
  }
  throw new Error('snapshot-page-budget-exhausted');
}
