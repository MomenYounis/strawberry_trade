import {selectArchiveYears} from './archive-calendar.mjs';
import {id,integer} from './validation.mjs';
import {verifyOpeningDatePlan} from './opening-date-policy.mjs';

/** Bounded, resumable orchestration, deliberately not registered with a live
 * cron. A production invocation needs separately accepted close/storage/policy
 * capabilities. Local tests can exercise the same state machine only against
 * explicitly synthetic adapters; they cannot issue production acceptance. */
export function createAnnualScheduler({stateStore,catalog,executeStep,config={},storage,now=Date.now,mode='production'}) {
 if(!stateStore||typeof catalog?.page!=='function'||typeof executeStep!=='function'||!['production','synthetic'].includes(mode))throw Error('scheduler-configuration');
 if(mode==='synthetic'&&(stateStore.adapter?.kind!=='synthetic'||storage?.kind!=='synthetic'))throw Error('synthetic-scheduler-adapters-required');
 const blockers=()=>{
  const result=[];
  if(config.schedulerEnabled!==true)result.push('scheduler-disabled');
  if(config.exportEnabled!==true)result.push('export-disabled');
  if(config.closeApproved!==true)result.push('financial-close-approval-required');
  if(config.openingBalancePolicy!=='dated-openings')result.push('opening-policy-required');
  if(mode==='production'){
   if(config.productionAcceptanceApproved!==true)result.push('production-acceptance-required');
   if(storage?.productionDurabilityAccepted!==true)result.push('durable-storage-not-accepted');
   if(config.independentRecoveryAccepted!==true||config.keyRecoveryAccepted!==true)result.push('recovery-acceptance-required');
  }
  return result;
 };
 return Object.freeze({
  async tick({afterTenant=null,maxTenants=5,owner='annual_scheduler'}={}) {
   integer(maxTenants,1,10);id(owner);if(afterTenant!==null)id(afterTenant);
   const blocked=blockers();if(blocked.length)return {status:'BLOCKED',blockers:blocked,nextTenant:afterTenant,processed:[]};
   const page=await catalog.page({afterTenant,limit:maxTenants});
   if(!Array.isArray(page.tenants)||page.tenants.length>maxTenants||typeof page.hasMore!=='boolean')throw Error('scheduler-catalog-page');
   let previous=afterTenant??'';const processed=[];
   for(const tenant of page.tenants){
    id(tenant.tenantId);if(tenant.tenantId<=previous)throw Error('scheduler-catalog-order');previous=tenant.tenantId;
    if(tenant.enabled!==true||tenant.adminDeleting)continue;
    if(config.openingBalancePolicy==='dated-openings'&&tenant.undatedOpeningCount!==0){processed.push({tenantId:tenant.tenantId,status:'BLOCKED',reason:'undated-openings'});continue;}
    const plan=selectArchiveYears({serverTimeMs:now(),existing:tenant.runs??[],selectedYears:tenant.selectedYears??[],administratorSelection:tenant.selectionApproved===true});
    const year=plan.years[0];if(year===undefined)continue;
    let run=await stateStore.read(tenant.tenantId,year),openingDateEvidence;
    if(!run||run.state==='eligible'){
     try{openingDateEvidence=verifyOpeningDatePlan({tenantId:tenant.tenantId,year,parties:tenant.openingParties,plan:tenant.openingDatePlan});}
     catch{processed.push({tenantId:tenant.tenantId,year,status:'BLOCKED',reason:'opening-date-plan-required'});continue;}
    }else if(!run.checkpoint?.openingDatePolicySha256){
     processed.push({tenantId:tenant.tenantId,year,status:'BLOCKED',reason:'legacy-opening-policy-review-required'});continue;
    }
    if(!run)run=await stateStore.create({tenantId:tenant.tenantId,year,runId:`annual_${year}`,explicitSelection:tenant.selectionApproved===true});
    let lease;
    try{lease=await stateStore.acquire(tenant.tenantId,year,owner);}
    catch(error){if(error.message==='archive-lease-held'){processed.push({tenantId:tenant.tenantId,year,status:'BUSY'});continue;}throw error;}
    if(run.state==='eligible')await stateStore.checkpoint(tenant.tenantId,year,lease,{authorizedClose:true,exportEnabled:true,openingDateEvidence});
    // One bounded step per tenant/tick. The supplied step reserves its own work
    // budget and persists progress. No prune or delete capability is supplied.
    const result=await executeStep({tenantId:tenant.tenantId,year,lease,maxNewChunks:1});
    processed.push({tenantId:tenant.tenantId,year,status:result.state});
   }
   if(page.hasMore&&!page.tenants.length)throw Error('scheduler-catalog-no-progress');
   return {status:'PASS',processed,nextTenant:page.hasMore?previous:null};
  },blockers,
 });
}
