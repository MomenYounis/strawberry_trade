import {randomBytes} from 'node:crypto';
import {id,integer} from './validation.mjs';
import {exportArchive,verifyArchive,ARCHIVE_LIMITS} from './archive-format.mjs';
import {createTemporaryRestoreSink} from './archive-storage.mjs';
import {createArchiveProjection} from './archive-projection.mjs';
import {immutableChangesAtCheckpoint} from './archive-accounting.mjs';

class ExportYield extends Error {}

// This coordinator is a private Node preparation/verification tool, not a Worker
// scheduled handler. It requires an explicitly checkpointed run, a fenced lease,
// a quota reservation, a caller-supplied private key, and a bounded source. It
// never closes a financial year, configures infrastructure, or deletes records.
export async function runArchiveExportStep({stateStore,tenantId,year,lease,sourceFactory,
  storage,masterKey,keyId,budget,maxNewChunks=4,maxSourceChanges=500_000,pageSize=100,
  chunkBytes=ARCHIVE_LIMITS.chunkBytes,createRestoreSink=createTemporaryRestoreSink,
  now=Date.now}) {
  id(tenantId);id(keyId);integer(maxNewChunks,1,8);integer(maxSourceChanges,1,500_000);integer(pageSize,1,250);
  if(!budget||typeof budget.reserve!=='function')throw new Error('archive-work-budget-required');
  if(typeof sourceFactory!=='function')throw new Error('archive-source-required');
  let workingLease=lease;
  const assertLease=async()=>{
    const run=await stateStore.assertCurrent(tenantId,year,workingLease);
    if(workingLease.expiresAtMs-now()<15_000)workingLease=await stateStore.renew(tenantId,year,workingLease);
    return run;
  };
  let run=await assertLease();
  if(['verified','cleanup_pending','complete'].includes(run.state))return {state:run.state,run,lease:workingLease};
  if(!['checkpointed','exporting','uploaded'].includes(run.state)||!run.checkpoint)throw new Error('archive-checkpoint-required');
  if(run.checkpoint.sequence>maxSourceChanges)throw new Error('source-projection-budget');
  const sourcePages=Math.ceil(run.checkpoint.sequence/pageSize)+1;
  const priorChunks=run.exportProgress?.chunks.length??0;
  // Conservative attempt reservation includes restore rereads and prefix replay;
  // no reservation is refunded after interruption. Estimates are not billing.
  await budget.reserve({tenantId,stepId:`export_${randomBytes(8).toString('hex')}`,costs:{
    firestoreReads:run.checkpoint.sequence+sourcePages+32+8*(maxNewChunks+priorChunks),
    firestoreWrites:16+4*(maxNewChunks+priorChunks),firestoreDeletes:0,workerRequests:1,
    r2ClassA:maxNewChunks+1,r2ClassB:2*ARCHIVE_LIMITS.maxChunks+2,
    downloadBytes:2*ARCHIVE_LIMITS.maxTotalBytes+ARCHIVE_LIMITS.maxManifestBytes}});
  let previousCloseHash=null;
  if(year>2026){const previous=await stateStore.read(tenantId,year-1);if(!previous?.manifest||previous.runId!==run.checkpoint.previousClose||previous.evidence?.verified?.manifestSha256!==previous.manifest.sha256)throw new Error('previous-verified-archive-required');previousCloseHash=previous.manifest.sha256;}
  const context={tenantId,year,runId:run.runId,closingSequence:run.checkpoint.sequence,
    closingVersion:run.checkpoint.version,previousCloseHash,keyId,createdAtMs:run.createdAtMs};
  let source;
  try{
    source=await sourceFactory(context);
    if(source?.isolated!==true||typeof source.records!=='function'||typeof source.trustedControls!=='function'||typeof source.destroy!=='function')throw new Error('isolated-source-projection-required');
    const trustedControls=await source.trustedControls();
    if(trustedControls.unknownPayrollMonths?.length)throw new Error('unknown-payroll-obligations');
    await assertLease();
    if(run.state==='checkpointed')run=await stateStore.advance(tenantId,year,workingLease,'checkpointed','exporting');
    if(run.state==='exporting') {
      const result=await exportArchive({storage,masterKey,context,records:source.records(),trustedControls,
        chunkBytes,resume:run.exportProgress?.chunks??[],assertLease,
        onCheckpoint:async progress=>{
          // Replayed prefix chunks are already durable. Replacing their stored
          // checkpoint with a shorter prefix would regress resumable progress.
          if(progress.chunks.length<=priorChunks)return;
          await stateStore.recordExportCheckpoint(tenantId,year,workingLease,progress);
          if(progress.chunks.length-priorChunks>=maxNewChunks)throw new ExportYield();
        }});
      run=await stateStore.advance(tenantId,year,workingLease,'exporting','uploaded',{
        key:result.manifestKey,sha256:result.manifestSha256,keyId,closingSequence:context.closingSequence,
        closingVersion:context.closingVersion,tenantId,year,runId:run.runId});
    }
    const pointer=run.evidence.uploaded;
    if(pointer.keyId!==keyId)throw new Error('archive-resume-key-mismatch');
    await stateStore.publishManifest(tenantId,year,workingLease,{key:pointer.key,sha256:pointer.sha256});
    await assertLease();
    const evidence=await verifyArchive({storage,manifestKey:pointer.key,manifestSha256:pointer.sha256,
      masterKey,expected:context,trustedControls,sink:await createRestoreSink(),now});
    await assertLease();run=await stateStore.advance(tenantId,year,workingLease,'uploaded','verified',evidence);
    return {state:run.state,run,lease:workingLease};
  }catch(error){
    if(error instanceof ExportYield)return {state:'exporting',yielded:true,lease:workingLease};
    // Deliberately redacted classification. Retry records must not leak source
    // payloads, key material, provider response bodies, or credentials.
    try{await stateStore.recordRetry(tenantId,year,workingLease,{code:'archive_step_failed',retryAfterMs:now()+60_000});}catch{}
    throw error;
  }finally{if(source?.destroy)await source.destroy();}
}

export function firestoreArchiveSourceFactory(db,{pageSize=100,maxChanges=500_000,maxBytes=268_435_456}={}) {
  integer(pageSize,1,250);integer(maxChanges,1,500_000);
  return async context=>{
    const projection=await createArchiveProjection({context,maxChanges,maxBytes});
    try{await projection.ingest(immutableChangesAtCheckpoint(db,{tenantId:context.tenantId,
      sequence:context.closingSequence,pageSize,maxPages:Math.ceil(maxChanges/pageSize)+1}));return projection;}
    catch(error){await projection.destroy();throw error;}
  };
}
