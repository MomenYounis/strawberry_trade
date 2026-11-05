// Concrete private Node integration. Construction does not query Firestore,
// create keys/resources, register cron, or give any cleanup capability.
import {createAnnualScheduler} from './annual-scheduler.mjs';
import {createBoundedAnnualCatalog,createFirestoreAnnualCatalogAdapter} from './annual-catalog.mjs';
import {ArchiveStateStore,FirestoreArchiveStateAdapter} from './archive-state.mjs';
import {prepareArchiveSourceStep,preparedArchiveSourceFactory,firestorePreparationSource} from './archive-source-preparation.mjs';
import {runPreparedArchiveJob} from './archive-prepared-job.mjs';
import {ARCHIVE_LIMITS} from './archive-format.mjs';
import {integer,id} from './validation.mjs';
class TickYield extends Error {}

export function annualStorageBudgetModel(storage,seen=new Set(),depth=0){
 if(!storage||seen.has(storage)||depth>3)throw Error('annual-storage-model-required');seen.add(storage);
 if(storage.kind==='mirrored'){
  const primary=annualStorageBudgetModel(storage.primary,seen,depth+1),recovery=annualStorageBudgetModel(storage.recovery,seen,depth+1);
  return {writeA:primary.writeA+recovery.writeA,writeB:primary.writeB+recovery.writeB+primary.readB+recovery.readB,readB:primary.readB};
 }
 if(!['r2','node-r2','synthetic','synthetic-directory'].includes(storage.kind))throw Error('annual-storage-model-required');
 // An immutable R2 upload can need one collision readback. Charge that worst
 // case even for synthetic adapters; successful uploads do not refund quota.
 return {writeA:1,writeB:1,readB:1};
}

export function createPrivateAnnualEngine({stateStore,catalogAdapter,source,storage,masterKey,keyId,budget,
 config={},openingPlans=[],selections=[],catalogLimits={},seedProvider=null,now=Date.now,mode='production'}){
 if(!budget?.reserve||!stateStore||!['readState','readChanges'].every(method=>typeof source?.[method]==='function'))throw Error('annual-engine-configuration');
 if(mode==='synthetic'&&catalogAdapter?.kind!=='synthetic')throw Error('synthetic-annual-catalog-required');
 if(mode==='production'&&(stateStore.adapter?.kind!=='firestore'||catalogAdapter?.kind!=='firestore'))throw Error('production-annual-adapters-required');
 config=Object.freeze(structuredClone(config));id(keyId);
 const storageModel=storage?annualStorageBudgetModel(storage):null;
 const pageSize=integer(config.maxSourceRecordsPerStep??50,1,100),maxNewPages=integer(config.maxSourcePagesPerStep??1,1,4);
 const maxRuntimeMs=integer(config.maxJobRuntimeMs??240_000,1000,300_000),maxTickRuntimeMs=integer(config.maxTickRuntimeMs??300_000,1000,3_000_000);
 let tickStarted=null,running=false;
 const checkRuntime=()=>{if(tickStarted!==null&&now()-tickStarted>=maxTickRuntimeMs)throw new TickYield();};
 const sharedBudget={async reserve({tenantId,stepId,costs}){
  checkRuntime();
  // Storage fan-out is specific to this engine. Shared reservation I/O is
  // accounted once by ArchiveWorkBudget using its concrete budget adapter.
  const writes=costs.r2ClassA??0,writeReadbacks=writes*(storageModel?.writeB??0);
  const accounted={...costs};
  if(writes){accounted.r2ClassA=writes*storageModel.writeA;accounted.r2ClassB=(costs.r2ClassB??0)+writeReadbacks;accounted.downloadBytes=(costs.downloadBytes??0)+writeReadbacks*ARCHIVE_LIMITS.maxManifestBytes;}
  const reservation=await budget.reserve({tenantId,stepId,costs:accounted});
  checkRuntime();return reservation;
 }};
 const schedulerState={adapter:stateStore.adapter};
 for(const method of ['read','create','acquire','checkpoint'])schedulerState[method]=async(...args)=>{
  const tenantId=method==='create'?args[0].tenantId:args[0];
  await sharedBudget.reserve({tenantId,stepId:'scheduler_'+method,costs:{firestoreReads:15,firestoreWrites:10}});
  return stateStore[method](...args);
 };
 const catalog=createBoundedAnnualCatalog({...catalogLimits,adapter:catalogAdapter,budget:sharedBudget,openingPlans,selections,now});
 const executeStep=async({tenantId,year,lease})=>{
  checkRuntime();
  await sharedBudget.reserve({tenantId,stepId:'engine_state',costs:{firestoreReads:15,firestoreWrites:10}});
  const run=await stateStore.assertCurrent(tenantId,year,lease);
  if(['checkpointed','exporting'].includes(run.state)&&run.sourcePreparation?.sourceCursor!==run.checkpoint.sequence){
   const captured=await prepareArchiveSourceStep({stateStore,tenantId,year,lease,source,storage,masterKey,keyId,budget:sharedBudget,seedProvider,pageSize,maxNewPages,now});
   lease=captured.lease;
   if(captured.state!=='prepared')return {state:'preparing',lease,sourceCursor:captured.progress.sourceCursor};
  }
  const sourceFactory=preparedArchiveSourceFactory({stateStore,storage,masterKey,budget:sharedBudget,seedProvider});
  return runPreparedArchiveJob({stateStore,tenantId,year,lease,sourceFactory,storage,masterKey,keyId,budget:sharedBudget,maxRuntimeMs,
   chunkBytes:config.maxArchiveChunkBytes,now});
 };
 const scheduler=createAnnualScheduler({stateStore:schedulerState,catalog,executeStep,config,storage,now,mode});
 const blockers=()=>[...scheduler.blockers(),...(!storageModel?['archive-storage-required']:[]),...(!(masterKey instanceof Uint8Array)||masterKey.byteLength!==32?['archive-key-required']:[]),...(config.cleanupEnabled===true?['cleanup-not-supported-by-engine']:[])];
 return Object.freeze({blockers,
  async tick(options={}){
   if(running)return {status:'BUSY',processed:[]};
   const blocked=blockers();if(blocked.length)return {status:'BLOCKED',blockers:blocked,nextTenant:options.afterTenant??null,processed:[]};
   running=true;tickStarted=now();
   try{return await scheduler.tick({maxTenants:1,...options});}
   catch(error){if(error instanceof TickYield)return {status:'DEFERRED',reason:'tick-runtime',nextTenant:options.afterTenant??null,processed:[]};throw error;}
   finally{running=false;tickStarted=null;}
  },
 });
}

export function createFirestoreAnnualEngine({db,budget,now=Date.now,...options}){
 return createPrivateAnnualEngine({...options,budget,now,mode:'production',
  stateStore:new ArchiveStateStore(new FirestoreArchiveStateAdapter(db),{now}),
  catalogAdapter:createFirestoreAnnualCatalogAdapter(db),source:firestorePreparationSource(db)});
}
