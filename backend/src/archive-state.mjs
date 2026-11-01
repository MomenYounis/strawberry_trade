import {id, integer, canonical} from './validation.mjs';
import {annualInterval,eligibleYears,ARCHIVE_DEFAULTS} from './archive-calendar.mjs';

export const ARCHIVE_STATES=Object.freeze(['eligible','checkpointed','exporting','uploaded','verified',
  'cleanup_pending','pruning','complete']);
export const ARCHIVE_PROTOCOL_VERSION=2;
const clone=v=>structuredClone(v);
function validTime(v){return integer(v,0,8_640_000_000_000_000);}
function checkedLease(lease,now) {
  validTime(now);
  if(!lease||!Number.isSafeInteger(lease.fence)||lease.fence<1||lease.expiresAtMs<=now) throw new Error('stale-archive-lease');
  return lease;
}
function assertFence(run,lease,now) {
  checkedLease(lease,now);
  if(!run?.lease||run.lease.owner!==lease.owner||run.lease.fence!==lease.fence||run.lease.expiresAtMs<=now) throw new Error('stale-archive-lease');
}
function validateRun(run) {id(run.tenantId);id(run.runId);annualInterval(run.year);return run;}

// A transaction adapter must retry serialization conflicts and commit every
// change atomically. The Firestore implementation reads the same parent root as
// syncOperation, fencing financial-close writes against concurrent acceptance.
export class ArchiveStateStore {
  constructor(adapter,{now=Date.now}={}) {this.adapter=adapter;this.now=now;}
  async read(tenantId,year){return this.adapter.transaction(tenantId,year,async tx=>clone(tx.run));}
  async create({tenantId,runId,year,explicitSelection=false}) {
    validateRun({tenantId,runId,year});
    return this.adapter.transaction(tenantId,year, async tx=>{
      if(tx.run) {if(tx.run.runId!==runId)throw new Error('year-run-already-exists');return clone(tx.run);}
      const due=eligibleYears(this.now());
      if(!due.includes(year))throw new Error('year-not-eligible');
      const previousYear=tx.root.archivePolicy?.activeYearStart??2026;
      if(year!==previousYear)throw new Error('previous-close-required');
      if(year<due.at(-1)&&!explicitSelection)throw new Error('administrator-selection-required');
      tx.run={tenantId,year,runId,state:'eligible',fence:0,createdAtMs:this.now(),retry:null};
      return clone(tx.run);
    });
  }
  async acquire(tenantId,year,owner,ttlMs=60_000) {
    id(owner);integer(ttlMs,1000,300_000);
    return this.adapter.transaction(tenantId,year,async tx=>{
      if(!tx.run)throw new Error('archive-run-missing');
      const now=this.now();validTime(now);
      if(tx.run.lease?.expiresAtMs>now)throw new Error('archive-lease-held');
      const fence=integer(tx.run.fence+1,1,Number.MAX_SAFE_INTEGER);
      tx.run.fence=fence;tx.run.lease={owner,fence,expiresAtMs:now+ttlMs};
      return clone(tx.run.lease);
    });
  }
  async renew(tenantId,year,lease,ttlMs=60_000) {
    integer(ttlMs,1000,300_000);
    return this.adapter.transaction(tenantId,year,async tx=>{
      assertFence(tx.run,lease,this.now());tx.run.lease.expiresAtMs=this.now()+ttlMs;
      return clone(tx.run.lease);
    });
  }
  async assertCurrent(tenantId,year,lease) {
    return this.adapter.transaction(tenantId,year,async tx=>{assertFence(tx.run,lease,this.now());return clone(tx.run);});
  }
  async checkpoint(tenantId,year,lease,{authorizedClose=false,exportEnabled=false}={}) {
    if(!authorizedClose||!exportEnabled)throw new Error('financial-close-disabled');
    return this.adapter.transaction(tenantId,year,async tx=>{
      assertFence(tx.run,lease,this.now());
      if(tx.run.state!=='eligible') {if(tx.run.checkpoint)return clone(tx.run);throw new Error('invalid-archive-state');}
      if(tx.root.adminDeleting||tx.root.enabled!==true)throw new Error('tenant-not-active');
      if(!eligibleYears(this.now()).includes(year))throw new Error('year-not-eligible');
      if((tx.root.archivePolicy?.activeYearStart??2026)!==year)throw new Error('previous-close-required');
      if(year>2026&&tx.root.archivePolicy?.lastVerifiedYear!==year-1)throw new Error('previous-archive-verification-required');
      const interval=annualInterval(year), sequence=integer(tx.root.sequence??0,0,Number.MAX_SAFE_INTEGER);
      const version=integer((tx.root.archivePolicy?.closeVersion??0)+1,1,Number.MAX_SAFE_INTEGER);
      const previousClose=tx.root.archivePolicy?.lastRunId??null;
      tx.run.checkpoint={...interval,sequence,version,previousClose,capturedAtMs:this.now()};
      tx.run.state='checkpointed';
      tx.root.archivePolicy={...(tx.root.archivePolicy??{}),closedThroughDate:interval.endDate,
        closeVersion:version,checkpointSequence:sequence,activeYearStart:year+1,lastRunId:tx.run.runId};
      return clone(tx.run);
    });
  }
  async advance(tenantId,year,lease,from,to,evidence={}) {
    if(!['exporting','uploaded','verified','cleanup_pending'].includes(to)||ARCHIVE_STATES.indexOf(to)!==ARCHIVE_STATES.indexOf(from)+1)throw new Error('invalid-archive-transition');
    if(Buffer.byteLength(canonical(evidence))>32_000)throw new Error('archive-evidence-too-large');
    return this.adapter.transaction(tenantId,year,async tx=>{
      assertFence(tx.run,lease,this.now());
      if(tx.run.state!==from)throw new Error('invalid-archive-state');
      if(to==='uploaded'&&(!/^[a-f0-9]{64}$/.test(evidence.sha256)||typeof evidence.key!=='string'||!evidence.key.endsWith('/manifests/'+evidence.sha256)||!evidence.keyId))throw new Error('uploaded-manifest-evidence-required');
      if(to==='verified') {
        if(evidence.manifestSha256!==tx.run.manifest?.sha256||evidence.verifier!=='strawberry-restore-v1'||evidence.financialMatch!==true||evidence.identitiesMatch!==true||!Number.isSafeInteger(evidence.verifiedAtMs)||evidence.verifiedAtMs>this.now())throw new Error('verification-evidence-required');
        if(evidence.tenantId!==tenantId||evidence.year!==year||evidence.runId!==tx.run.runId||evidence.closingSequence!==tx.run.checkpoint.sequence||evidence.closingVersion!==tx.run.checkpoint.version||evidence.keyId!==tx.run.evidence.uploaded.keyId)throw new Error('verification-checkpoint-mismatch');
      }
      tx.run.state=to;tx.run.evidence={...(tx.run.evidence??{}),[to]:clone(evidence)};tx.run.updatedAtMs=this.now();
      if(to==='verified')tx.root.archivePolicy={...tx.root.archivePolicy,lastVerifiedYear:year};
      return clone(tx.run);
    });
  }
  async recordRetry(tenantId,year,lease,{code,retryAfterMs}) {
    id(code);validTime(retryAfterMs);
    return this.adapter.transaction(tenantId,year,async tx=>{assertFence(tx.run,lease,this.now());tx.run.retry={code,retryAfterMs};return clone(tx.run);});
  }
  async recordExportCheckpoint(tenantId,year,lease,progress) {
    if(!Array.isArray(progress.chunks)||progress.chunks.length>1024||Buffer.byteLength(canonical(progress))>500_000)throw new Error('archive-progress-limit');
    integer(progress.recordCount,0,500_000);
    return this.adapter.transaction(tenantId,year,async tx=>{
      assertFence(tx.run,lease,this.now());if(tx.run.state!=='exporting')throw new Error('invalid-archive-state');
      if((tx.run.exportProgress?.chunks.length??0)>progress.chunks.length)throw new Error('archive-progress-regression');
      const prior=tx.run.exportProgress?.chunks??[];
      if(canonical(prior)!==canonical(progress.chunks.slice(0,prior.length)))throw new Error('archive-progress-conflict');
      tx.run.exportProgress=clone(progress);return clone(tx.run);
    });
  }
  // Uploads from a stale worker can leave harmless orphan immutable chunks;
  // only this fenced transaction can publish their authoritative pointer.
  async publishManifest(tenantId,year,lease,{key,sha256}) {
    if(typeof key!=='string'||key.length>512||!/^[a-f0-9]{64}$/.test(sha256))throw new Error('invalid-manifest-pointer');
    return this.adapter.transaction(tenantId,year,async tx=>{
      assertFence(tx.run,lease,this.now());
      if(tx.run.state!=='uploaded')throw new Error('invalid-archive-state');
      if(tx.run.evidence?.uploaded?.key!==key||tx.run.evidence.uploaded.sha256!==sha256)throw new Error('manifest-evidence-mismatch');
      if(tx.run.manifest&&canonical(tx.run.manifest)!==canonical({key,sha256}))throw new Error('manifest-already-published');
      tx.run.manifest={key,sha256};return clone(tx.run);
    });
  }
}

export class FirestoreArchiveStateAdapter {
  constructor(db){this.db=db;this.kind='firestore';}
  async transaction(tenantId,year,fn) {
    id(tenantId);annualInterval(year);
    const root=this.db.doc(`tenants/${tenantId}`),runRef=root.collection('archiveRuns').doc(String(year));
    return this.db.runTransaction(async transaction=>{
      const [rootDoc,runDoc]=await Promise.all([transaction.get(root),transaction.get(runRef)]);
      if(!rootDoc.exists)throw new Error('tenant-missing');
      const context={root:rootDoc.data(),run:runDoc.exists?runDoc.data():null};
      const beforeRoot=canonical(context.root),beforeRun=canonical(context.run),result=await fn(context);
      if(canonical(context.root)!==beforeRoot)transaction.update(root,{archivePolicy:context.root.archivePolicy});
      if(canonical(context.run)!==beforeRun)transaction.set(runRef,context.run);
      return result;
    });
  }
}

// Explicit synthetic marker: this adapter cannot provide durability evidence.
export class SyntheticArchiveStateAdapter {
  constructor(roots){this.roots=new Map(Object.entries(clone(roots)));this.runs=new Map();this.kind='synthetic';this.queue=Promise.resolve();}
  transaction(tenantId,year,fn){
    const result=this.queue.then(async()=>{
      const root=this.roots.get(tenantId);if(!root)throw new Error('tenant-missing');
      const key=`${tenantId}/${year}`,context={root:clone(root),run:clone(this.runs.get(key)??null)};
      const result=await fn(context);this.roots.set(tenantId,context.root);if(context.run)this.runs.set(key,context.run);return result;
    });
    this.queue=result.catch(()=>{});return result;
  }
}

export function cleanupBlockers({config=ARCHIVE_DEFAULTS,run,lease,now=Date.now(),storage,
  independentRecovery=false,keyRecoveryTested=false,retentionChecked=false,dependenciesResolved=false,
  protocolAcceptance=false,productionAcceptance=false,expectedCheckpoint}={}) {
  const blockers=[];
  if(config.cleanupEnabled!==true)blockers.push('cleanup-disabled');
  try{assertFence(run,lease,now);}catch{blockers.push('stale-archive-lease');}
  if(run?.state!=='cleanup_pending')blockers.push('not-cleanup-pending');
  const verification=run?.evidence?.verified;
  if(!verification||verification.financialMatch!==true||verification.identitiesMatch!==true||verification.manifestSha256!==run?.manifest?.sha256)blockers.push('verification-required');
  if(!Number.isInteger(config.graceDays)||config.graceDays<1||config.graceDays>3650||!verification||!Number.isSafeInteger(verification.verifiedAtMs)||now-verification.verifiedAtMs<config.graceDays*86400000)blockers.push('retention-grace');
  if(!storage||storage.kind!=='r2'||storage.productionDurabilityAccepted!==true)blockers.push('durable-storage-not-accepted');
  for(const [passed,label] of [[independentRecovery,'independent-recovery-required'],[keyRecoveryTested,'key-recovery-required'],[retentionChecked,'retention-review-required'],[dependenciesResolved,'unresolved-dependencies'],[protocolAcceptance,'protocol-acceptance-required'],[productionAcceptance,'production-acceptance-required']])if(passed!==true)blockers.push(label);
  if(!expectedCheckpoint||canonical(expectedCheckpoint)!==canonical(run?.checkpoint))blockers.push('checkpoint-mismatch');
  // This candidate deliberately exposes no delete method. A future reviewed
  // implementation must add conditional bounded deletion and floor snapshots.
  blockers.push('pruner-not-implemented');
  return blockers;
}
