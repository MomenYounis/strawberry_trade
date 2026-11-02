import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalViewer,HISTORICAL_STATEMENT_LIMITS} from '../src/historical-view.mjs';
import {exportArchive} from '../src/archive-format.mjs';
import {ArchiveControlReader} from '../src/archive-accounting.mjs';
import {SyntheticArchiveStorage} from '../src/archive-storage.mjs';
import {canonical} from '../src/validation.mjs';

const tenantId='synthetic_statement_tenant';
const invoice=(id,{kind='sale',date='2027-08-31',partyId='customer',totalMinor=2000000,qtyMilli=10000,priceMinor=200000,paidMinor=0,...extra}={})=>({id,tenantId,kind,date,partyId,partyName:'عميل اختباري',qtyMilli,priceMinor,totalMinor,paidMinor,grade:'أول',unit:'كجم',...extra});
const payment=(id,{date='2027-09-02',kind='merchant_payment',partyId='customer',paidMinor=500000,...extra}={})=>({id,tenantId,kind,date,partyId,totalMinor:paidMinor,paidMinor,...extra});
const reversal=(id,originalId,date='2027-10-03')=>({id,tenantId,kind:'reversal',date,originalId,note:'عكس موثق للاختبار'});

async function fixture({year=2027,runId=`statement_${year}`,accounts=[{id:'customer',role:'merchant',balanceMinor:2000000}],entries=[],references=[],snapshots=true,chunkBytes=1024,chunksPerRequest=1,previousCloseHash=null}={}) {
  const masterKey=Buffer.alloc(32,63),sequence=references.length+entries.length+1;
  const context={tenantId,year,runId,closingSequence:sequence,closingVersion:year-2025,previousCloseHash,keyId:'synthetic_statement_key',createdAtMs:Date.parse(`${year+1}-09-01T00:00:00Z`)};
  const records=[];
  if(snapshots)for(const account of accounts.filter((a,i,all)=>all.findIndex(v=>v.id===a.id)===i))records.push({type:'snapshot',tenantId,year,sequence:1,payload:{id:account.id,entity:'party',record:{id:account.id,tenantId,kind:account.role,name:'عميل اختباري',openingMinor:987654,revision:1}}});
  records.push({type:'opening',tenantId,year,sequence:0,payload:{id:'recorded_net',role:'cash_movement',balanceMinor:0}});
  for(const account of accounts)records.push({type:'opening',tenantId,year,sequence:0,payload:account});
  for(let i=0;i<references.length;i++)records.push({type:'reference',tenantId,year,sequence:i+1,payload:references[i]});
  for(let i=0;i<entries.length;i++)records.push({type:'entry',tenantId,year,sequence:references.length+i+2,payload:entries[i]});
  // Sequence is the source checkpoint; references and directory events occupy
  // different accepted positions in real fixtures. Only financial entry order
  // matters here, and the final sequence must include every synthetic entry.
  context.closingSequence=references.length+entries.length+1;
  const reader=new ArchiveControlReader(context);for(const row of records)reader.accept(row);
  const storage=new SyntheticArchiveStorage(),controls=reader.finish();
  const result=await exportArchive({storage,masterKey,context,records,trustedControls:controls,chunkBytes,assertLease:async()=>{}});
  const run={tenantId,year,runId,state:'verified',checkpoint:{sequence:context.closingSequence,version:context.closingVersion},manifest:{key:result.manifestKey,sha256:result.manifestSha256},evidence:{uploaded:{keyId:context.keyId},verified:{manifestSha256:result.manifestSha256,financialMatch:true,identitiesMatch:true}}};
  const catalog={get:async()=>run,list:async()=>({runs:[run],nextYear:null})};
  const viewer=createHistoricalViewer({catalog,storage,keyResolver:async()=>masterKey,chunksPerRequest});
  return {viewer,run,catalog,storage,masterKey,context,records,controls};
}
async function collect(f,partyId='customer') {
  const pages=[];let nextChunk=0,manifestSha256=null;
  do {
    const page=await f.viewer.readStatement({tenantId,year:f.context.year,partyId,nextChunk,manifestSha256});
    assert.equal(page.fragment.fromChunk,nextChunk);assert.equal(page.archived,true);assert.equal(page.readOnly,true);
    if(pages.length)assert.equal(canonical(page.statement),canonical(pages[0].statement));
    pages.push(page);nextChunk=page.nextChunk;manifestSha256=page.statement.manifestSha256;
    assert(Buffer.byteLength(JSON.stringify(page))<=HISTORICAL_STATEMENT_LIMITS.responseBytes);
  }while(nextChunk!==null);
  return pages;
}
// A small independent consumer demonstrates the complete-fragment contract.
// It uses exact integers, treats historical references as evidence only, and
// never creates an entry, receipt, opening balance, or active ledger mutation.
function summarize(pages) {
  const target=new Map(),period=new Map(),rows=[],identities=new Set();
  for(const page of pages)for(const row of [...page.fragment.entries,...page.fragment.references]) {
    assert(!target.has(row.entry.id));target.set(row.entry.id,row);
  }
  for(const page of pages) {
    for(const row of page.fragment.entries) {
      assert(!identities.has(row.entry.id));identities.add(row.entry.id);
      period.set(row.role,(period.get(row.role)??0n)+BigInt(row.partyEffectMinor));rows.push(row);
    }
    for(const row of page.fragment.reversals) {
      assert(!Object.hasOwn(row,'partyEffectMinor'));
      const original=target.get(row.entry.originalId);if(!original)continue; // evidence for another party
      assert(!identities.has(row.entry.id));identities.add(row.entry.id);
      period.set(original.role,(period.get(original.role)??0n)-BigInt(original.partyEffectMinor));rows.push({...row,role:original.role,partyEffectMinor:-original.partyEffectMinor});
    }
  }
  const accounts=pages[0].statement.accounts.map(a=>({...a,computedPeriod:Number(period.get(a.role)??0n),computedClosing:Number(BigInt(a.openingMinor)+(period.get(a.role)??0n))}));
  for(const account of accounts){assert.equal(account.computedPeriod,account.periodMinor);assert.equal(account.computedClosing,account.closingMinor);}
  return {accounts,rows:rows.sort((a,b)=>a.sequence-b.sequence)};
}

test('two annual statements carry EGP20000 to15000; original party opening is never reposted',async()=>{
  const first=await fixture({year:2026,accounts:[{id:'customer',role:'merchant',balanceMinor:0}],entries:[invoice('prior_sale')]});
  const next=await fixture({year:2027,previousCloseHash:first.run.manifest.sha256,entries:[payment('september_payment')]});
  const firstPages=await collect(first),nextPages=await collect(next);
  assert.equal(summarize(firstPages).accounts[0].computedClosing,2000000);
  const account=summarize(nextPages).accounts[0];assert.equal(account.openingMinor,2000000);assert.equal(account.computedPeriod,-500000);assert.equal(account.computedClosing,1500000);
  assert.equal(nextPages.flatMap(p=>p.fragment.partySnapshots)[0].openingMinor,987654);
  assert.equal(nextPages.flatMap(p=>p.fragment.openingBaselines)[0].balanceMinor,2000000);
  assert.equal(nextPages.at(-1).status,'complete');
});
test('supplier payable and merchant receivable with same stable ID remain separate roles',async()=>{
  const f=await fixture({accounts:[{id:'customer',role:'merchant',balanceMinor:2000000},{id:'customer',role:'supplier',balanceMinor:3000000}],
    entries:[payment('customer_receipt'),payment('supplier_payment',{kind:'supplier_payment',paidMinor:700000})]});
  const summary=summarize(await collect(f));assert.deepEqual(summary.accounts.map(a=>[a.role,a.computedClosing]),[['merchant',1500000],['supplier',2300000]]);
  assert.deepEqual(summary.rows.map(r=>r.role),['merchant','supplier']);
});
test('signed advances and zero activity preserve exact baseline',async()=>{
  const f=await fixture({accounts:[{id:'customer',role:'merchant',balanceMinor:-100000}],entries:[payment('advance',{paidMinor:50000})]});
  assert.equal(summarize(await collect(f)).accounts[0].computedClosing,-150000);
  const empty=await fixture({accounts:[{id:'customer',role:'merchant',balanceMinor:-100000}]});
  const result=summarize(await collect(empty));assert.equal(result.accounts[0].computedClosing,-100000);assert.equal(result.rows.length,0);
});
test('cross-year return and reversals resolve original evidence across pages without posting references',async()=>{
  const old=invoice('old_sale'),other=invoice('other_purchase',{kind:'purchase',partyId:'supplier'});
  const returned=invoice('partial_return',{kind:'sale_return',date:'2027-09-12',originalId:'old_sale',qtyMilli:2500,totalMinor:500000});
  const f=await fixture({accounts:[{id:'customer',role:'merchant',balanceMinor:2000000},{id:'supplier',role:'supplier',balanceMinor:2000000}],references:[old,other],
    entries:[returned,reversal('reverse_return','partial_return'),reversal('reverse_other','other_purchase')]});
  const pages=await collect(f),summary=summarize(pages);
  assert(pages.length>1);assert.equal(summary.accounts[0].computedClosing,2000000);
  assert.deepEqual(summary.rows.map(r=>[r.entry.id,r.partyEffectMinor]),[['partial_return',-500000],['reverse_return',500000]]);
  assert.deepEqual(pages.flatMap(p=>p.fragment.references).map(r=>r.entry.id),['old_sale']);
  assert.deepEqual(pages.flatMap(p=>p.fragment.reversals).map(r=>r.entry.id),['reverse_return','reverse_other']);
  for(const raw of pages.flatMap(p=>p.fragment.reversals)){assert(!Object.hasOwn(raw,'partyEffectMinor'));assert(!Object.hasOwn(raw,'role'));}
});
test('prior-year invoice reversal affects current period only, and correction keeps both dates',async()=>{
  const corrected=payment('current_correction',{date:'2027-11-02',paidMinor:10000,originalBusinessDate:'2027-08-29',correctionOfOperationId:'late_original'});
  const f=await fixture({references:[invoice('prior_invoice')],entries:[reversal('current_reversal','prior_invoice'),corrected]});
  const pages=await collect(f),summary=summarize(pages);
  assert.equal(summary.accounts[0].computedClosing,-10000);
  const row=summary.rows.find(r=>r.entry.id==='current_correction');assert.equal(row.entry.date,'2027-11-02');assert.equal(row.entry.originalBusinessDate,'2027-08-29');assert.equal(row.entry.correctionOfOperationId,'late_original');
});
test('repeated complete statements keep storage, source records and master key unchanged',async()=>{
  const f=await fixture({entries:[payment('receipt')]});const before=canonical({run:f.run,records:f.records,objects:[...f.storage.objects].map(([key,value])=>[key,value.toString('base64')])});
  let previous;
  for(let i=0;i<3;i++){const pages=await collect(f);summarize(pages);if(previous)assert.equal(canonical(pages),previous);previous=canonical(pages);}
  assert.equal(canonical({run:f.run,records:f.records,objects:[...f.storage.objects].map(([key,value])=>[key,value.toString('base64')])}),before);assert(f.masterKey.every(n=>n===63));
  assert.deepEqual(Object.keys(f.viewer).sort(),['list','readRecord','readStatement']);
});
test('continuation requires exact publication identity; replacement between pages fails closed',async()=>{
  const f=await fixture({entries:[payment('receipt'),payment('receipt2')]});
  const first=await f.viewer.readStatement({tenantId,year:2027,partyId:'customer'});assert.equal(first.status,'continue');
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',nextChunk:first.nextChunk}),/identity-required/);
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',nextChunk:first.nextChunk,manifestSha256:'a'.repeat(64)}),/publication-changed/);
  const other=await fixture({runId:'replacement_run',entries:[payment('different')]});Object.assign(f.run,other.run);
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',nextChunk:first.nextChunk,manifestSha256:first.statement.manifestSha256}),/publication-changed/);
});
test('publication revoked or changed during a page is rechecked before contents return',async()=>{
  const f=await fixture({entries:[payment('receipt')]});let calls=0;
  const catalog={...f.catalog,get:async()=>{calls++;return calls===1?f.run:{...f.run,state:'exporting'};}};
  const viewer=createHistoricalViewer({catalog,storage:f.storage,keyResolver:async()=>f.masterKey});
  await assert.rejects(()=>viewer.readStatement({tenantId,year:2027,partyId:'customer'}),/not-published/);assert.equal(calls,2);
});
test('unknown parties terminate without financial rows and invalid inputs fail',async()=>{
  const f=await fixture({entries:[payment('receipt')]});const missing=await f.viewer.readStatement({tenantId,year:2027,partyId:'absent'});
  assert.equal(missing.status,'not_found');assert.deepEqual(missing.statement.accounts,[]);assert.equal(missing.nextChunk,null);
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'../customer'}));
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',nextChunk:-1}));
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',nextChunk:999,manifestSha256:f.run.manifest.sha256}),/cursor/);
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer',manifestSha256:'bad'}),/identity/);
});
test('a fully paid invoice still requires its explicit financial role despite zero party effect',async()=>{
  const f=await fixture({accounts:[{id:'customer',role:'supplier',balanceMinor:0}],entries:[invoice('wrong_role',{date:'2027-09-02',paidMinor:2000000})]});
  await assert.rejects(()=>collect(f),/archive-statement-role-mismatch/);
});
test('wrong tenant, wrong key, tampered manifest, corrupted chunk and outage return no statement',async()=>{
  const f=await fixture({entries:[payment('receipt')]});
  await assert.rejects(()=>f.viewer.readStatement({tenantId:'wrong_tenant',year:2027,partyId:'customer'}),/not-published/);
  const badKey=createHistoricalViewer({catalog:f.catalog,storage:f.storage,keyResolver:async()=>Buffer.alloc(32,0)});
  await assert.rejects(()=>badKey.readStatement({tenantId,year:2027,partyId:'customer'}),/authentication/);
  const manifestBytes=Buffer.from(f.storage.objects.get(f.run.manifest.key));f.storage.objects.get(f.run.manifest.key)[0]^=1;
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer'}),/manifest-integrity/);f.storage.objects.set(f.run.manifest.key,manifestBytes);
  const chunkKey=[...f.storage.objects.keys()].find(k=>k.includes('/chunks/'));f.storage.objects.get(chunkKey)[0]^=1;
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer'}),/chunk-integrity/);
  f.storage.read=async()=>{throw new Error('synthetic-storage-outage');};
  await assert.rejects(()=>f.viewer.readStatement({tenantId,year:2027,partyId:'customer'}),/synthetic-storage-outage/);
});
test('row and byte caps stop at whole chunk boundary and preserve deterministic complete order',async()=>{
  const entries=Array.from({length:2400},(_,i)=>payment(`receipt_${String(i).padStart(4,'0')}`,{paidMinor:100,date:'2027-09-02'}));
  const f=await fixture({entries,chunkBytes:131072,chunksPerRequest:8});let reads=0;
  const read=f.storage.read.bind(f.storage);f.storage.read=async(...args)=>{reads++;return read(...args);};
  const first=await f.viewer.readStatement({tenantId,year:2027,partyId:'customer'});
  assert.equal(first.status,'continue');assert(reads<=9); // one manifest plus at most eight chunks
  const rowCount=Object.values(first.fragment).filter(Array.isArray).reduce((sum,rows)=>sum+rows.length,0);
  assert(rowCount<=HISTORICAL_STATEMENT_LIMITS.fragmentRecords);assert(first.fragment.toChunkExclusive>0);
  const pages=await collect(f),summary=summarize(pages);assert(pages.length>=2);assert.equal(summary.rows.length,entries.length);
  assert.deepEqual(summary.rows.map(r=>r.entry.id),entries.map(e=>e.id));assert.equal(summary.accounts[0].computedClosing,1760000);
});


test('prior-year return reversal needs the retained return reference only, without reposting its invoice',async()=>{
  const oldReturn=invoice('old_return',{kind:'sale_return',date:'2027-08-31',originalId:'older_invoice',qtyMilli:2500,totalMinor:500000});
  const f=await fixture({accounts:[{id:'customer',role:'merchant',balanceMinor:1500000}],references:[oldReturn],
    entries:[reversal('reverse_old_return','old_return')]});
  const summary=summarize(await collect(f));
  assert.equal(summary.accounts[0].computedClosing,2000000);
  assert.deepEqual(summary.rows.map(row=>[row.entry.id,row.partyEffectMinor]),[['reverse_old_return',500000]]);
});
