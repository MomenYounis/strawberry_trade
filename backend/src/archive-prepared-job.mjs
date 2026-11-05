// Private Node job: reconstruct once from encrypted prepared pages, stream the
// annual export, persist every chunk, and independently restore before verify.
// Infrastructure, close authorization, scheduling and deletion are not enabled.
import {id,integer} from './validation.mjs';
import {isPreparedArchiveSourceFactory} from './archive-source-preparation.mjs';
import {exportArchive,verifyArchive,ARCHIVE_LIMITS} from './archive-format.mjs';
import {createTemporaryRestoreSink} from './archive-storage.mjs';
class JobYield extends Error {}
export async function runPreparedArchiveJob({stateStore,tenantId,year,lease,sourceFactory,storage,
 masterKey,keyId,budget,maxRuntimeMs=240_000,chunkBytes=ARCHIVE_LIMITS.chunkBytes,
 createRestoreSink=createTemporaryRestoreSink,now=Date.now}){
 id(tenantId);id(keyId);integer(maxRuntimeMs,1000,300_000);
 if(!isPreparedArchiveSourceFactory(sourceFactory)||!budget?.reserve)throw Error('prepared-source-and-budget-required');
 const started=now();let workingLease=lease,source;
 const checkRuntime=()=>{if(now()-started>=maxRuntimeMs)throw new JobYield();};
 const reserve=async(stepId,costs)=>{checkRuntime();await budget.reserve({tenantId,stepId,costs});checkRuntime();};
 const state=async(method,...args)=>{await reserve('prepared_'+method,{firestoreReads:15,firestoreWrites:10});return stateStore[method](...args);};
 const assertLease=async()=>{
  const run=await state('assertCurrent',tenantId,year,workingLease);
  if(workingLease.expiresAtMs-now()<30_000)workingLease=await state('renew',tenantId,year,workingLease);
  return run;
 };
 // Source reconstruction uses its own reserved read budget. Its cooperative
 // checkpoints must still honour this invocation's runtime and renew a live
 // lease, even before the exporter begins making storage/state calls.
 const beforeSourceWork=async()=>{
  checkRuntime();
  if(workingLease.expiresAtMs-now()<30_000)await assertLease();
  checkRuntime();
 };
 const boundedStorage={kind:storage.kind,productionDurabilityAccepted:storage.productionDurabilityAccepted===true,
  async read(key,options){await reserve('prepared_download',{r2ClassB:1,downloadBytes:options.maxBytes});return storage.read(key,options);},
  async putImmutable(key,bytes){await assertLease();await reserve('prepared_upload',{r2ClassA:1});return storage.putImmutable(key,bytes);}};
 try{
  let run=await assertLease();if(['verified','cleanup_pending','complete'].includes(run.state))return {state:run.state,lease:workingLease};
  if(!['checkpointed','exporting','uploaded'].includes(run.state)||!run.checkpoint)throw Error('archive-checkpoint-required');
  let previousCloseHash=null;
  if(year>2026){const previous=await state('read',tenantId,year-1);
   if(!previous?.manifest||previous.runId!==run.checkpoint.previousClose||previous.evidence?.verified?.manifestSha256!==previous.manifest.sha256)throw Error('previous-verified-archive-required');previousCloseHash=previous.manifest.sha256;
  }
  const context={tenantId,year,runId:run.runId,closingSequence:run.checkpoint.sequence,
   closingVersion:run.checkpoint.version,previousCloseHash,keyId,createdAtMs:run.createdAtMs};
  source=await sourceFactory(context,{beforeWork:beforeSourceWork});await assertLease();
  const trustedControls=await source.trustedControls();await beforeSourceWork();if(trustedControls.unknownPayrollMonths?.length)throw Error('unknown-payroll-obligations');
  if(run.state==='checkpointed')run=await state('advance',tenantId,year,workingLease,'checkpointed','exporting');
  if(run.state==='exporting'){
   const prior=run.exportProgress?.chunks.length??0;
   const result=await exportArchive({storage:boundedStorage,masterKey,context,records:source.records(),trustedControls,chunkBytes,
    resume:run.exportProgress?.chunks??[],assertLease,onCheckpoint:async progress=>{
     if(progress.chunks.length>prior)await state('recordExportCheckpoint',tenantId,year,workingLease,progress);
    }});
   run=await state('advance',tenantId,year,workingLease,'exporting','uploaded',{
    key:result.manifestKey,sha256:result.manifestSha256,keyId,tenantId,year,runId:run.runId,
    closingSequence:context.closingSequence,closingVersion:context.closingVersion});
  }
  const pointer=run.evidence.uploaded;if(pointer.keyId!==keyId)throw Error('archive-resume-key-mismatch');
  await state('publishManifest',tenantId,year,workingLease,{key:pointer.key,sha256:pointer.sha256});
  await assertLease();const sink=await createRestoreSink();
  const evidence=await verifyArchive({storage:boundedStorage,manifestKey:pointer.key,manifestSha256:pointer.sha256,
   masterKey,expected:context,trustedControls,sink,now});
  await assertLease();await state('advance',tenantId,year,workingLease,'uploaded','verified',evidence);
  return {state:'verified',lease:workingLease,evidence};
 }catch(error){
  if(error instanceof JobYield)return {state:'deferred',reason:'runtime-budget',lease:workingLease};
  // Reservation failures occur before I/O. Persisted chunks are safe to replay.
  // Do not spend an unreserved write trying to record a failed reservation.
  throw error;
 }finally{await source?.destroy();}
}
