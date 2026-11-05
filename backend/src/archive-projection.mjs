// Private Node verifier/export preparation runtime. This module is intentionally
// not imported by the Worker: local SQLite scratch is not durable cloud storage.
import {DatabaseSync} from 'node:sqlite';
import {chmod} from 'node:fs/promises';
import {createPrivateScratch} from './private-scratch.mjs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {annualInterval} from './archive-calendar.mjs';
import {validateArchiveRecord} from './archive-accounting.mjs';
import {isVerifiedManagerSnapshotProjection} from './active-snapshot-projection.mjs';

// Archive identity and controls must not depend on the host ICU locale.
const compareCodeUnits=(a,b)=>a<b?-1:a>b?1:0;

const maxInteger=BigInt(Number.MAX_SAFE_INTEGER);
function exact(v){const n=BigInt(v);if(n>maxInteger||n< -maxInteger)throw new Error('source-control-overflow');return Number(n);}
const sourceKinds=['entry','party','employee','salary_term','submission','review'];

export async function createArchiveProjection({context,seed=null,maxChanges=500_000,maxBytes=268_435_456,beforeWork=null}) {
  if(beforeWork!==null&&typeof beforeWork!=='function')throw new Error('source-progress-check-required');
  if(beforeWork)await beforeWork();
  let workUnits=0;const checkpoint=()=>beforeWork!==null&&++workUnits%128===0;
  context=Object.freeze(structuredClone(context));
  id(context.tenantId);id(context.runId);annualInterval(context.year);integer(context.closingSequence,0,Number.MAX_SAFE_INTEGER);
  integer(maxChanges,1,500_000);integer(maxBytes,1024,536_870_912);
  const scratch=await createPrivateScratch('annual_projection'),directory=scratch.directory;
  let database;
  try{database=new DatabaseSync(join(directory,'projection.sqlite'));await chmod(join(directory,'projection.sqlite'),0o600);
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; CREATE TABLE records(entity TEXT NOT NULL,id TEXT NOT NULL,sequence INTEGER NOT NULL,effective_date TEXT,payload TEXT NOT NULL,PRIMARY KEY(entity,id)); CREATE INDEX entry_dates ON records(entity,effective_date,sequence);');
  }catch(error){database?.close();await scratch.destroy();throw error;}
  let destroyed=false,sealed=false,failed=false,lastSequence=0,totalBytes=0,changeCount=0;
  const get=database.prepare('SELECT sequence,payload FROM records WHERE entity=? AND id=?');
  const save=database.prepare('INSERT INTO records(entity,id,sequence,effective_date,payload) VALUES(?,?,?,?,?) ON CONFLICT(entity,id) DO UPDATE SET sequence=excluded.sequence,effective_date=excluded.effective_date,payload=excluded.payload');
  const parse=row=>row?{sequence:row.sequence,payload:JSON.parse(row.payload)}:null;
  function sourceEffect(entry){
    const value=entry.kind==='reversal'?parse(get.get('entry',entry.originalId))?.payload:entry;
    if(!value||['reversal','shipment_update'].includes(value.kind)&&entry.kind==='reversal')throw new Error('source-original-missing');
    const sign=entry.kind==='reversal'?-1n:1n,total=BigInt(value.totalMinor??0),paid=BigInt(value.paidMinor??0);
    let role=null,party=0n;
    if(value.partyId){const partyRecord=parse(get.get('party',value.partyId))?.payload;if(!partyRecord)throw new Error('source-party-missing');role=partyRecord.kind;}
    switch(value.kind){case 'sale':case 'purchase':party=total-paid;break;case 'merchant_payment':case 'supplier_payment':party=-paid;break;case 'sale_return':case 'purchase_return':party=paid-total;break;case 'balance_adjustment':party=value.adjustmentDirection==='increase'?total:-total;break;}
    return {value,role,party:sign*party,cash:sign*(new Set(['sale','merchant_payment','purchase_return']).has(value.kind)?paid:-paid),sign};
  }
  function snapshotRow(entity,row){return {type:'snapshot',tenantId:context.tenantId,year:context.year,sequence:row.sequence,payload:{entity,id:row.payload.id,record:row.payload}};}
  async function openingRowsAndControls(){
    if(!sealed)throw new Error('source-checkpoint-not-sealed');
    if(beforeWork)await beforeWork();
    const {startDate,endDate}=annualInterval(context.year),accounts=new Map(),periodTotals={};let cashOpening=0n,cashPeriod=0n;
    const addAccount=(role,accountId,opening=0n)=>{const key=`${role}/${accountId}`;if(!accounts.has(key)){if(accounts.size>=10_000)throw new Error('source-account-limit');accounts.set(key,{role,id:accountId,opening,period:0n});}return accounts.get(key);};
    for(const stored of database.prepare("SELECT payload FROM records WHERE entity='party' ORDER BY id").iterate()){if(checkpoint())await beforeWork();const p=JSON.parse(stored.payload);addAccount(p.kind,p.id,BigInt(p.openingMinor??0));}
    for(const stored of database.prepare("SELECT payload,effective_date FROM records WHERE entity='entry' AND effective_date<? ORDER BY effective_date,sequence").iterate(endDate)){
      if(checkpoint())await beforeWork();
      const e=JSON.parse(stored.payload),fx=sourceEffect(e),prior=e.date<startDate;
      if(prior)cashOpening+=fx.cash;else cashPeriod+=fx.cash;
      const apply=(role,accountId,delta)=>{if(!delta)return;const a=addAccount(role,accountId);if(prior)a.opening+=delta;else a.period+=delta;exact(a.opening+a.period);};
      apply(fx.role,fx.value.partyId,fx.party);
      if(fx.value.kind==='payroll')apply('payroll_paid',`${fx.value.employeeId}_${fx.value.salaryMonth}`,fx.sign*BigInt(fx.value.paidMinor));
      if(!prior){const t=periodTotals[fx.value.kind]??={totalMinor:0n,paidMinor:0n,qtyMilli:0n};for(const field of Object.keys(t))t[field]+=fx.sign*BigInt(fx.value[field]??0);}
    }
    addAccount('cash_movement','recorded_net',cashOpening).period=cashPeriod;
    if(beforeWork)await beforeWork();
    const sorted=[...accounts.values()].sort((a,b)=>compareCodeUnits(`${a.role}/${a.id}`,`${b.role}/${b.id}`));
    return {openings:sorted.map(a=>({type:'opening',tenantId:context.tenantId,year:context.year,sequence:0,payload:{id:a.id,role:a.role,balanceMinor:exact(a.opening)}})),
      accounts:sorted.map(a=>({id:a.id,role:a.role,openingMinor:exact(a.opening),periodMinor:exact(a.period),closingMinor:exact(a.opening+a.period)})),
      periodTotals:Object.fromEntries(Object.entries(periodTotals).map(([kind,totals])=>[kind,Object.fromEntries(Object.entries(totals).map(([field,value])=>[field,exact(value)]))])),
      periodRecordedCashMinor:exact(cashPeriod),cumulativeRecordedCashMinor:exact(cashOpening+cashPeriod)};
  }
  async function* annualRecords(){
    const {startDate,endDate}=annualInterval(context.year),base=await openingRowsAndControls();
    for(const stored of database.prepare("SELECT entity,sequence,payload FROM records WHERE entity!='entry' ORDER BY entity,id").iterate()){
      if(checkpoint())await beforeWork();
      const row=snapshotRow(stored.entity,parse(stored));validateArchiveRecord(row,context);yield row;
    }
    for(const row of base.openings){if(checkpoint())await beforeWork();yield row;}
    // SQL DISTINCT bounds dependency extraction without holding yearly payloads.
    const refs=database.prepare("SELECT DISTINCT json_extract(payload,'$.originalId') AS original_id FROM records WHERE entity='entry' AND effective_date>=? AND effective_date<? AND json_extract(payload,'$.originalId') IS NOT NULL AND json_extract(payload,'$.originalId')!='' ORDER BY original_id");
    for(const {original_id:originalId} of refs.iterate(startDate,endDate)){
      if(checkpoint())await beforeWork();
      const original=parse(get.get('entry',originalId));if(!original)throw new Error('source-original-missing');
      if(original.payload.date<startDate)yield {type:'reference',tenantId:context.tenantId,year:context.year,sequence:original.sequence,payload:original.payload};
    }
    for(const stored of database.prepare("SELECT sequence,payload FROM records WHERE entity='entry' AND effective_date>=? AND effective_date<? ORDER BY sequence").iterate(startDate,endDate)){if(checkpoint())await beforeWork();yield {type:'entry',tenantId:context.tenantId,year:context.year,...parse(stored)};}
  }
  function acceptSourceRecord(change){
    if(!sourceKinds.includes(change.entity)||change.id!==change.payload?.id||change.payload?.tenantId!==context.tenantId)throw new Error('invalid-source-change');
    integer(change.sequence,1,context.closingSequence);id(change.id);
    const encoded=canonical(change.payload);totalBytes+=Buffer.byteLength(encoded);changeCount++;
    if(changeCount>maxChanges||totalBytes>maxBytes||Buffer.byteLength(encoded)>24_000)throw new Error('source-projection-budget');
    const existing=parse(get.get(change.entity,change.id));
    if(existing&&change.entity!=='submission')throw new Error('source-immutable-record-rewritten');
    if(existing){
      const stable=p=>Object.fromEntries(Object.entries(p).filter(([key])=>!['status','approvedUnitMinor','reviewNote'].includes(key)));
      if(existing.payload.status!=='pending'||!['approved','rejected'].includes(change.payload.status)||canonical(stable(existing.payload))!==canonical(stable(change.payload)))throw new Error('source-submission-status-rewritten');
    }
    if(change.entity==='entry'){
      const record={type:'entry',tenantId:context.tenantId,year:Number(change.payload.date?.slice(0,4))-(change.payload.date?.slice(5)<'09-01'?1:0),sequence:change.sequence,payload:change.payload};
      validateArchiveRecord(record,{...context,year:record.year});
    }else validateArchiveRecord(snapshotRow(change.entity,{sequence:change.sequence,payload:change.payload}),context);
    save.run(change.entity,change.id,change.sequence,change.payload.date??null,encoded);
  }
  try{
    if(seed){
      if(!isVerifiedManagerSnapshotProjection(seed)||seed.scope.tenantId!==context.tenantId||seed.checkpointSequence>context.closingSequence)throw new Error('verified-manager-snapshot-required');
      for await(const row of seed.iterateFullRecords()){if(checkpoint())await beforeWork();acceptSourceRecord(row);}
      lastSequence=seed.checkpointSequence;
    }
  }catch(error){database.close();await scratch.destroy();throw error;}
  return {
    isolated:true,context,seedSequence:lastSequence,
    async ingest(changes){
      if(destroyed||sealed||failed)throw new Error('source-projection-closed');
      try{
      for await(const change of changes){
        if(checkpoint())await beforeWork();
        if(change.sequence!==lastSequence+1||change.sequence>context.closingSequence)throw new Error('source-sequence-gap');
        acceptSourceRecord(change);lastSequence=change.sequence;
      }
      if(lastSequence!==context.closingSequence)throw new Error('source-sequence-gap');sealed=true;
      return {changes:changeCount,bytes:totalBytes,sequence:lastSequence};
      }catch(error){failed=true;throw error;}
    },
    records:annualRecords,
    async trustedControls(){
      const {accounts,periodTotals,periodRecordedCashMinor,cumulativeRecordedCashMinor}=await openingRowsAndControls();
      const digest=createHash('sha256'),counts={opening:0,entry:0,reference:0,snapshot:0},snapshotCounts={};let pendingSubmissions=0;
      for await(const row of annualRecords()){counts[row.type]++;digest.update(canonical(row)+'\n');if(row.type==='snapshot'){snapshotCounts[row.payload.entity]=(snapshotCounts[row.payload.entity]??0)+1;if(row.payload.entity==='submission'&&row.payload.record.status==='pending')pendingSubmissions++;}}
      const signedTotal=role=>exact(accounts.filter(a=>a.role===role).reduce((sum,a)=>sum+BigInt(a.closingMinor),0n));
      const salaryTerms=[];
      for(const row of database.prepare("SELECT payload FROM records WHERE entity='salary_term'").iterate()){if(checkpoint())await beforeWork();salaryTerms.push(JSON.parse(row.payload));}
      const payrollObligations=[],unknownPayrollMonths=[];
      for(const employeeId of [...new Set(salaryTerms.map(t=>t.employeeId))].sort(compareCodeUnits)){
        if(checkpoint())await beforeWork();
        const applicable=salaryTerms.filter(t=>t.employeeId===employeeId).sort((a,b)=>compareCodeUnits(a.effectiveMonth,b.effectiveMonth));
        if(new Set(applicable.map(t=>t.effectiveMonth)).size!==applicable.length)throw new Error('duplicate-salary-effective-month');
        const first=applicable[0].effectiveMonth,start=Number(first.slice(0,4))*12+Number(first.slice(5))-1,last=(context.year+1)*12+7;
        if(last-start+1+payrollObligations.length>20_000)throw new Error('payroll-month-limit');
        for(let monthIndex=start;monthIndex<=last;monthIndex++){
          if(checkpoint())await beforeWork();
          const month=`${Math.floor(monthIndex/12)}-${String(monthIndex%12+1).padStart(2,'0')}`;
          const entitlement=applicable.filter(t=>t.effectiveMonth<=month).at(-1).monthlyMinor;
          const paid=accounts.find(a=>a.role==='payroll_paid'&&a.id===`${employeeId}_${month}`)?.closingMinor??0;
          payrollObligations.push({employeeId,salaryMonth:month,entitlementMinor:entitlement,paidMinor:paid,balanceMinor:exact(BigInt(entitlement)-BigInt(paid))});
        }
      }
      for(const account of accounts.filter(a=>a.role==='payroll_paid')){if(checkpoint())await beforeWork();const salaryMonth=account.id.slice(-7),employeeId=account.id.slice(0,-8);if(!salaryTerms.some(t=>t.employeeId===employeeId&&t.effectiveMonth<=salaryMonth))unknownPayrollMonths.push({employeeId,salaryMonth});}
      return {counts,identitySha256:digest.digest('hex'),accounts,periodTotals,snapshotCounts,pendingSubmissions,payrollObligations,unknownPayrollMonths,
        signedReceivablesMinor:signedTotal('merchant'),signedPayablesMinor:signedTotal('supplier'),periodRecordedCashMinor,cumulativeRecordedCashMinor};
    },
    async destroy(){if(destroyed)return;destroyed=true;try{database.close();}finally{await scratch.destroy();}},
  };
}
