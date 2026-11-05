// Private Node scheduler inventory. Read-only, bounded and shared-budgeted;
// not a cron registration, opening-date inference or production acceptance.
import {FieldPath} from 'firebase-admin/firestore';
import {canonical,id,integer,hash} from './validation.mjs';
import {ARCHIVE_STATES} from './archive-state.mjs';
import {annualInterval,selectArchiveYears} from './archive-calendar.mjs';

function rootIdentity(tenantId,root){
 if(!root||typeof root!=='object')throw Error('annual-tenant-missing');
 return {tenantId,enabled:root.enabled===true,adminDeleting:!!root.adminDeleting,
  sequence:integer(root.sequence??0,0,Number.MAX_SAFE_INTEGER),
  historyFloor:integer(root.historyFloor??0,0,Number.MAX_SAFE_INTEGER),
  archivePolicy:root.archivePolicy??null};
}
function checkedRows(rows,limit,after,maxDocumentBytes){
 if(!Array.isArray(rows)||rows.length>limit)throw Error('annual-catalog-page');
 let previous=after??'';
 for(const row of rows){id(row.id);if(row.id<=previous||!row.payload||Buffer.byteLength(canonical(row.payload))>maxDocumentBytes)throw Error('annual-catalog-order-or-size');previous=row.id;}
 return rows;
}
function runSummary(tenantId,row){
 const run=row.payload;annualInterval(run.year);id(run.runId);
 if(row.id!==String(run.year)||run.tenantId!==tenantId||!ARCHIVE_STATES.includes(run.state))throw Error('annual-catalog-run-scope');
 let state=run.state;
 // Cleanup has a separate lifecycle. A verified financial predecessor remains
 // verified for the next annual close while optional feed cleanup is pending.
 if(['verified','cleanup_pending','pruning','complete'].includes(state)){
  const evidence=run.evidence?.verified;
  if(!run.manifest||!/^[a-f0-9]{64}$/.test(run.manifest.sha256)||evidence?.manifestSha256!==run.manifest.sha256||evidence.financialMatch!==true||evidence.identitiesMatch!==true)throw Error('annual-catalog-run-verification');
  state='verified';
 }
 return {tenantId,year:run.year,runId:run.runId,state,...(state!==run.state?{cleanupState:run.state}:{})};
}

export function createBoundedAnnualCatalog({adapter,budget,openingPlans=[],selections=[],now=Date.now,
 pageSize=25,maxRuns=64,maxParties=10_000,maxBytes=8_388_608}){
 if(!budget?.reserve||!['listTenants','readTenant','listRuns','listOpeningParties'].every(method=>typeof adapter?.[method]==='function'))throw Error('annual-catalog-configuration');
 integer(pageSize,1,100);integer(maxRuns,1,256);integer(maxParties,1,10_000);integer(maxBytes,1024,16_777_216);
 if(!Array.isArray(openingPlans)||openingPlans.length>100||!Array.isArray(selections)||selections.length>100||Buffer.byteLength(canonical({openingPlans,selections}))>16_777_216)throw Error('annual-catalog-review-limit');
 const plans=new Map(),chosen=new Map();
 for(const plan of structuredClone(openingPlans)){id(plan.tenantId);annualInterval(plan.year);const key=plan.tenantId+'/'+plan.year;if(plans.has(key))throw Error('duplicate-opening-plan');plans.set(key,plan);}
 for(const selection of structuredClone(selections)){
  id(selection.tenantId);id(selection.reviewedByUid);
  if(chosen.has(selection.tenantId)||selection.approved!==true||!Array.isArray(selection.years)||selection.years.length>64)throw Error('annual-selection-review-required');
  chosen.set(selection.tenantId,selection);
 }
 const reserve=async(step,reads)=>budget.reserve({tenantId:'annual_catalog',stepId:step,costs:{firestoreReads:reads}});
 async function scan(method,tenantId,maximum,maxDocumentBytes){
  const result=[];let after=null,bytes=0;
  for(let page=0;page<=Math.ceil(maximum/pageSize);page++){
   const limit=Math.min(pageSize,maximum-result.length)+1;
   await reserve('catalog_'+method,limit);
   const rows=checkedRows(await adapter[method]({tenantId,after,limit}),limit,after,maxDocumentBytes);
   const accepted=rows.slice(0,limit-1);
   for(const row of accepted){bytes+=Buffer.byteLength(canonical(row.payload));if(bytes>maxBytes)throw Error('annual-catalog-byte-limit');result.push(row);}
   if(rows.length<limit)return result;
   if(result.length===maximum)throw Error('annual-catalog-record-limit');
   after=accepted.at(-1).id;
  }
  throw Error('annual-catalog-page-limit');
 }
 return Object.freeze({kind:adapter.kind,
  async page({afterTenant=null,limit=5}={}){
   integer(limit,1,10);if(afterTenant!==null)id(afterTenant);
   await reserve('catalog_tenants',limit+1);
   const listed=checkedRows(await adapter.listTenants({afterTenant,limit:limit+1}),limit+1,afterTenant,32_768),tenants=[];
   for(const item of listed.slice(0,limit)){
    const tenantId=item.id,identity=rootIdentity(tenantId,item.payload),selection=chosen.get(tenantId);
    if(!identity.enabled||identity.adminDeleting){tenants.push({...identity,undatedOpeningCount:0,runs:[]});continue;}
    const runs=(await scan('listRuns',tenantId,maxRuns,1_048_576)).map(row=>runSummary(tenantId,row));
    const selectedYears=selection?.years??[],selectionApproved=selection?.approved===true;
    const year=selectArchiveYears({serverTimeMs:now(),existing:runs,selectedYears,administratorSelection:selectionApproved}).years[0];
    const existing=runs.find(run=>run.year===year),needsPlan=year!==undefined&&(!existing||existing.state==='eligible');
    const openingParties=needsPlan?(await scan('listOpeningParties',tenantId,maxParties,24_000)).map(row=>{
     if(row.payload.id!==row.id||row.payload.tenantId!==tenantId)throw Error('annual-opening-party-scope');return row.payload;
    }):[];
    await reserve('catalog_tenant_recheck',1);
    const latest=rootIdentity(tenantId,await adapter.readTenant({tenantId}));
    if(hash(latest)!==hash(identity))throw Error('annual-catalog-snapshot-changed');
    const openingDatePlan=plans.get(tenantId+'/'+year)??null;
    if(needsPlan&&openingDatePlan&&openingDatePlan.checkpointSequence!==identity.sequence)throw Error('opening-date-plan-stale');
    tenants.push({...identity,runs,selectedYears,selectionApproved,openingParties,openingDatePlan,undatedOpeningCount:0});
   }
   return {tenants,hasMore:listed.length>limit};
  },
 });
}

export function createFirestoreAnnualCatalogAdapter(db){
 if(typeof db?.collection!=='function'||typeof db?.doc!=='function')throw Error('annual-firestore-required');
 const docs=async query=>(await query.get()).docs.map(doc=>({id:doc.id,payload:doc.data()}));
 const page=(collection,after,limit)=>{integer(limit,1,101);let query=collection.orderBy(FieldPath.documentId());if(after!==null){id(after);query=query.startAfter(after);}return query.limit(limit);};
 return Object.freeze({kind:'firestore',
  listTenants:({afterTenant=null,limit})=>docs(page(db.collection('tenants'),afterTenant,limit)),
  async readTenant({tenantId}){return (await db.doc('tenants/'+id(tenantId)).get()).data();},
  listRuns:({tenantId,after=null,limit})=>docs(page(db.doc('tenants/'+id(tenantId)).collection('archiveRuns'),after,limit)),
  listOpeningParties:({tenantId,after=null,limit})=>docs(page(db.doc('tenants/'+id(tenantId)).collection('parties'),after,limit)),
 });
}
