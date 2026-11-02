// Private operator primitive. No HTTP route, scheduler, enabled production
// configuration, financial-document deletion, or production acceptance is added.
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {annualInterval,cairoDate,ARCHIVE_DEFAULTS} from './archive-calendar.mjs';
import {isVerifiedManagerSnapshotProjection} from './active-snapshot-projection.mjs';

const sha=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const hash=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('invalid-prune-hash');return value;};
const copy=value=>structuredClone(value);
const PAGE_SIZE=20,MAX_PAGES=25_000,MAX_PAGE_BYTES=12_000;
const verifiedPlans=new WeakSet();
function exact(value,fields){if(!value||Object.getPrototypeOf(value)!==Object.prototype||(Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))))throw new Error('invalid-prune-schema');}
function version(value){exact(value,['seconds','nanoseconds']);integer(value.seconds,0,8_640_000_000_000);integer(value.nanoseconds,0,999_999_999);return value;}
const documentId=sequence=>String(sequence).padStart(16,'0');

/** Capture only metadata, proving every body hash against the exact contiguous
 * feed used by the verified manager snapshot, rather than trusting a later scan.
 * writePage must conditionally persist immutable private bytes; its return value
 * is a locator, never evidence of durable production storage or recovery. */
export async function createFeedPrunePlan({projection,tenantId,year,runId,snapshotHeaderSha256,source,writePage,budget}){
 id(tenantId);id(runId);annualInterval(year);hash(snapshotHeaderSha256);
 if(!isVerifiedManagerSnapshotProjection(projection)||projection.scope.tenantId!==tenantId||typeof writePage!=='function'||!budget?.reserve)throw new Error('trusted-prune-source-required');
 const fromSequence=projection.sourceFromSequence,checkpointSequence=projection.checkpointSequence;
 const identity=createHash('sha256'),pages=[];let after=fromSequence,records=[];
 async function flush(){
  if(!records.length)return;
  if(pages.length>=MAX_PAGES)throw new Error('prune-plan-limit');
  const page={index:pages.length,records};const bytes=Buffer.from(canonical(page));
  if(bytes.length>MAX_PAGE_BYTES)throw new Error('prune-plan-limit');
  await budget.reserve({tenantId,stepId:`prune_plan_write_${page.index}`,costs:{r2ClassA:1}});
  const key=await writePage({index:page.index,sha256:sha(bytes.toString()),bytes});
  if(typeof key!=='string'||!key.length||key.length>512||key.includes('..'))throw new Error('invalid-prune-key');
  pages.push({index:page.index,sha256:sha(bytes.toString()),recordCount:records.length,key});records=[];
 }
 // source is an internal bounded iterator of {id,data,updateTime}; production
 // callers must reserve its Firestore reads before fetching each source page.
 for await(const document of source){
  const sequence=document.data?.sequence;
  if(sequence!==after+1||sequence>checkpointSequence||document.id!==documentId(sequence))throw new Error('prune-source-gap');
  const bodySha256=sha(document.data);identity.update(bodySha256+'\n');
  records.push({id:document.id,sequence,bodySha256,updateTime:copy(version(document.updateTime))});after=sequence;
  if(records.length===PAGE_SIZE)await flush();
 }
 if(after!==checkpointSequence||identity.digest('hex')!==projection.sourceDocumentHashesSha256)throw new Error('prune-source-identity-mismatch');
 await flush();
 const manifest={format:'feed_prune_plan',version:1,tenantId,year,runId,snapshotHeaderSha256,fromSequence,checkpointSequence,
  sourceDocumentHashesSha256:projection.sourceDocumentHashesSha256,recordCount:checkpointSequence-fromSequence,pages};
 return {manifest,sha256:sha(manifest)};
}

/** Re-read and validate all immutable metadata before authorizing any deletion.
 * The expected hash must come from the protected run's operator publication. */
export async function verifyFeedPrunePlan({manifest,expectedSha256,readPage,budget}){
 exact(manifest,['format','version','tenantId','year','runId','snapshotHeaderSha256','fromSequence','checkpointSequence','sourceDocumentHashesSha256','recordCount','pages']);
 if(Buffer.byteLength(canonical(manifest))>8_388_608)throw new Error('prune-plan-limit');
 id(manifest.tenantId);id(manifest.runId);annualInterval(manifest.year);hash(expectedSha256);hash(manifest.snapshotHeaderSha256);hash(manifest.sourceDocumentHashesSha256);
 integer(manifest.fromSequence,0,Number.MAX_SAFE_INTEGER);integer(manifest.checkpointSequence,manifest.fromSequence,Number.MAX_SAFE_INTEGER);
 if(manifest.format!=='feed_prune_plan'||manifest.version!==1||sha(manifest)!==expectedSha256||!Array.isArray(manifest.pages)||manifest.pages.length>MAX_PAGES||manifest.recordCount!==manifest.checkpointSequence-manifest.fromSequence||manifest.recordCount>500_000||typeof readPage!=='function'||!budget?.reserve)throw new Error('invalid-prune-plan');
 const frozen=copy(manifest);let after=frozen.fromSequence;const identity=createHash('sha256');
 async function pageAt(index){
  const descriptor=frozen.pages[index];if(!descriptor)throw new Error('invalid-prune-page');
  exact(descriptor,['index','sha256','recordCount','key']);hash(descriptor.sha256);
  integer(descriptor.recordCount,1,PAGE_SIZE);
  if(descriptor.index!==index||typeof descriptor.key!=='string'||descriptor.key.length>512||descriptor.key.includes('..'))throw new Error('invalid-prune-page');
  await budget.reserve({tenantId:frozen.tenantId,stepId:`prune_plan_read_${index}`,costs:{r2ClassB:1,downloadBytes:MAX_PAGE_BYTES}});
  const bytes=await readPage(descriptor.key,{maxBytes:MAX_PAGE_BYTES});
  if(!(bytes instanceof Uint8Array)||bytes.length>MAX_PAGE_BYTES||sha(Buffer.from(bytes).toString('utf8'))!==descriptor.sha256)throw new Error('prune-page-integrity');
  let page;try{page=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('invalid-prune-page');}
  exact(page,['index','records']);if(canonical(page)!==Buffer.from(bytes).toString()||page.index!==index||!Array.isArray(page.records)||page.records.length!==descriptor.recordCount)throw new Error('invalid-prune-page');
  for(const row of page.records){exact(row,['id','sequence','bodySha256','updateTime']);integer(row.sequence,1,frozen.checkpointSequence);if(row.id!==documentId(row.sequence))throw new Error('invalid-prune-document');hash(row.bodySha256);version(row.updateTime);}
  return page;
 }
 for(let index=0;index<frozen.pages.length;index++)for(const row of (await pageAt(index)).records){if(row.sequence!==after+1)throw new Error('prune-plan-gap');identity.update(row.bodySha256+'\n');after=row.sequence;}
 if(after!==frozen.checkpointSequence||identity.digest('hex')!==frozen.sourceDocumentHashesSha256)throw new Error('prune-plan-identity-mismatch');
 const plan=Object.freeze({get manifest(){return copy(frozen);},sha256:expectedSha256,pageAt});verifiedPlans.add(plan);return plan;
}

function checkGates({root,run,lease,manifest,planSha256,config,storage,mode,now}){
 if(config.cleanupEnabled!==true)throw new Error('cleanup-disabled');
 if(cairoDate(now)<annualInterval(manifest.year).endDate)throw new Error('year-not-eligible');
 if(root.adminDeleting||root.enabled!==true)throw new Error('tenant-not-active');
 if(!run||!['cleanup_pending','pruning','complete'].includes(run.state)||run.tenantId!==manifest.tenantId||run.year!==manifest.year||run.runId!==manifest.runId||run.checkpoint?.sequence!==manifest.checkpointSequence)throw new Error('prune-checkpoint-mismatch');
 integer(now,0,8_640_000_000_000_000);integer(root.sequence,manifest.checkpointSequence,Number.MAX_SAFE_INTEGER);
 integer(run.checkpoint.version,1,Number.MAX_SAFE_INTEGER);hash(run.manifest?.sha256);
 if(!lease||typeof lease.owner!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(lease.owner)||run.lease?.owner!==lease.owner||run.lease?.fence!==lease.fence||!Number.isSafeInteger(lease.fence)||lease.fence<1||!Number.isSafeInteger(lease.expiresAtMs)||lease.expiresAtMs<=now||!Number.isSafeInteger(run.lease.expiresAtMs)||run.lease.expiresAtMs<=now)throw new Error('stale-archive-lease');
 if((root.minimumSyncProtocol??1)>2)throw new Error('unsupported-minimum-sync-protocol');
 integer(root.minimumSyncProtocol??1,1,2);integer(root.historyFloor??0,0,Number.MAX_SAFE_INTEGER);
 const verified=run.evidence?.verified,snapshot=run.evidence?.activeSnapshot,accepted=run.evidence?.cleanupAcceptance;
 if(!verified||verified.financialMatch!==true||verified.identitiesMatch!==true||verified.manifestSha256!==run.manifest?.sha256||verified.closingSequence!==manifest.checkpointSequence||verified.closingVersion!==run.checkpoint.version)throw new Error('verification-required');
 if(!Number.isInteger(config.graceDays)||config.graceDays<1||config.graceDays>3650||!Number.isSafeInteger(verified.verifiedAtMs)||now-verified.verifiedAtMs<config.graceDays*86400000)throw new Error('retention-grace');
 if(!snapshot||snapshot.headerSha256!==manifest.snapshotHeaderSha256||snapshot.checkpointSequence!==manifest.checkpointSequence||snapshot.fromSequence!==manifest.fromSequence||snapshot.sourceDocumentHashesSha256!==manifest.sourceDocumentHashesSha256||snapshot.verified!==true)throw new Error('verified-active-snapshot-required');
 if(!accepted||accepted.planSha256!==planSha256||accepted.snapshotHeaderSha256!==manifest.snapshotHeaderSha256||accepted.manifestSha256!==run.manifest.sha256||accepted.closingSequence!==manifest.checkpointSequence||accepted.closingVersion!==run.checkpoint.version)throw new Error('cleanup-acceptance-mismatch');
 for(const key of ['independentRecovery','keyRecoveryTested','retentionChecked','dependenciesResolved','protocolAcceptance','clientInstallAcceptance'])if(accepted[key]!==true)throw new Error(`cleanup-${key}-required`);
 if(mode==='production'&&(storage?.kind!=='r2'||storage.productionDurabilityAccepted!==true||accepted.productionAcceptance!==true||!accepted.approvalId))throw new Error('production-cleanup-not-accepted');
 if(mode==='synthetic'&&(storage?.kind!=='synthetic'||accepted.synthetic!==true))throw new Error('synthetic-cleanup-boundary');
 if((root.historyFloor??0)>manifest.checkpointSequence||(root.historyFloor??0)<manifest.fromSequence)throw new Error('prune-history-floor-mismatch');
 // Any registered source consumer may still require this prefix. A closing
 // checkpoint at/above C does not prove its replay cursor or seed is safe.
 if(root.archivePolicy?.pendingFeedConsumers!==undefined&&(!Array.isArray(root.archivePolicy.pendingFeedConsumers)||root.archivePolicy.pendingFeedConsumers.length>0))throw new Error('dependent-export-in-progress');
}

/** At most 20 duplicate manager-feed documents per transaction. The full
 * financial ledger, employee feed, all receipts/locks, current identities and
 * permissions are retained. A stopped partial run never pretends deleted rows
 * are still present: its raised floor and durable cursor remain authoritative. */
export async function runFeedPruneStep({adapter,tenantId,year,lease,plan,budget,storage,config=ARCHIVE_DEFAULTS,mode='production',now=Date.now}){
 id(tenantId);annualInterval(year);
 if(!verifiedPlans.has(plan)||!budget?.reserve||!['production','synthetic'].includes(mode)||
    (mode==='synthetic'&&adapter?.kind!=='synthetic')||(mode==='production'&&adapter?.kind!=='firestore'))throw new Error('verified-pruner-required');
 const manifest=plan.manifest;if(manifest.tenantId!==tenantId||manifest.year!==year)throw new Error('prune-scope-mismatch');
 // Reserve worst-case retry reads before even the non-mutating preflight.
 await budget.reserve({tenantId,stepId:'feed_prune_preflight',costs:{firestoreReads:15}});
 function checkedProgress(run,root){
  const progress=run.pruneProgress??{page:0,deleted:0,planSha256:plan.sha256};
  exact(progress,['page','deleted','planSha256']);integer(progress.page,0,manifest.pages.length);
  const expectedDeleted=manifest.pages.slice(0,progress.page).reduce((total,page)=>total+page.recordCount,0);
  if(progress.planSha256!==plan.sha256||progress.deleted!==expectedDeleted||(run.state==='complete'&&(progress.page!==manifest.pages.length||progress.deleted!==manifest.recordCount))||(run.state==='cleanup_pending'&&progress.page!==0))throw new Error('prune-progress-invalid');
  if(progress.deleted>0&&(root.historyFloor!==manifest.checkpointSequence||(root.minimumSyncProtocol??1)<2))throw new Error('pruned-history-floor-regressed');
  return progress;
 }
 // Recheck before storage I/O; the mutating transaction rechecks every gate.
 const before=await adapter.transaction(tenantId,year,async tx=>{checkGates({...tx,lease,manifest,planSha256:plan.sha256,config,storage,mode,now:now()});return copy(checkedProgress(tx.run,tx.root));});
 if(before.planSha256!==plan.sha256)throw new Error('prune-plan-changed');
 const page=before.page<manifest.pages.length?await plan.pageAt(before.page):null;
 await budget.reserve({tenantId,stepId:`feed_prune_${before.page}`,costs:{firestoreReads:5*(3+PAGE_SIZE),firestoreWrites:10,firestoreDeletes:5*PAGE_SIZE}});
 return adapter.transaction(tenantId,year,async tx=>{
  checkGates({...tx,lease,manifest,planSha256:plan.sha256,config,storage,mode,now:now()});
  const progress=checkedProgress(tx.run,tx.root);
  if(canonical(progress)!==canonical(before))throw new Error('prune-progress-changed');
  if(tx.run.state==='complete')return {state:'complete',...copy(progress)};
  if(typeof tx.assertNoPendingFeedConsumers==='function')await tx.assertNoPendingFeedConsumers();
  else if(mode==='production')throw new Error('feed-consumer-guard-required');
  if(page){
   const documents=await tx.getFeedDocuments(page.records.map(row=>row.id));
   if(documents.length!==page.records.length)throw new Error('prune-document-missing');
   // Validate EVERY candidate before queuing any delete. A missing original is
   // never assumed to have been deleted by an earlier unrecorded attempt.
   for(let index=0;index<documents.length;index++){
    const document=documents[index],expected=page.records[index];
    if(!document||document.id!==expected.id||sha(document.data)!==expected.bodySha256||canonical(document.updateTime)!==canonical(expected.updateTime))throw new Error('prune-document-changed');
   }
   // The same transaction publishes the floor/minimum before its first delete.
   // Concurrent financial writes use the same parent and retry above C.
   tx.root.historyFloor=manifest.checkpointSequence;tx.root.minimumSyncProtocol=Math.max(tx.root.minimumSyncProtocol??1,2);
   for(const row of page.records)tx.deleteFeedDocument(row.id);
   progress.page++;progress.deleted+=page.records.length;
  }
  tx.run.pruneProgress=copy(progress);tx.run.updatedAtMs=now();
  tx.run.state=progress.page===manifest.pages.length?'complete':'pruning';
  if(tx.run.state==='complete'&&progress.deleted!==manifest.recordCount)throw new Error('prune-count-mismatch');
  return {state:tx.run.state,...copy(progress)};
 });
}

export class FirestoreFeedPruneAdapter {
 constructor(db){this.db=db;this.kind='firestore';}
 transaction(tenantId,year,fn){
  id(tenantId);annualInterval(year);const root=this.db.doc(`tenants/${tenantId}`),run=root.collection('archiveRuns').doc(String(year));
  return this.db.runTransaction(async transaction=>{
   const [rootDoc,runDoc]=await Promise.all([transaction.get(root),transaction.get(run)]);
   if(!rootDoc.exists)throw new Error('tenant-missing');const deletes=[];
   const context={root:rootDoc.data(),run:runDoc.exists?runDoc.data():null,
    assertNoPendingFeedConsumers:async()=>{
     // A same/later checkpoint still needs this prefix when rebuilding from
     // zero. No persisted proof establishes that another active run can reseed.
     // This run is cleanup_pending/pruning/complete, outside these states.
     const query=root.collection('archiveRuns').where('state','in',['checkpointed','exporting','uploaded']).limit(1);
     if(!(await transaction.get(query)).empty)throw new Error('dependent-export-in-progress');
    },
    getFeedDocuments:async ids=>{if(ids.length>PAGE_SIZE)throw new Error('prune-batch-limit');return Promise.all(ids.map(async key=>{const doc=await transaction.get(root.collection('changes').doc(key));return doc.exists?{id:doc.id,data:doc.data(),updateTime:{seconds:doc.updateTime.seconds,nanoseconds:doc.updateTime.nanoseconds}}:null;}));},
    deleteFeedDocument:key=>deletes.push(key)};
   const priorRoot=canonical(context.root),priorRun=canonical(context.run),result=await fn(context);
   if(canonical(context.root)!==priorRoot)transaction.update(root,{historyFloor:context.root.historyFloor,minimumSyncProtocol:context.root.minimumSyncProtocol});
   if(canonical(context.run)!==priorRun)transaction.set(run,context.run);
   for(const key of deletes)transaction.delete(root.collection('changes').doc(key));return result;
  },{maxAttempts:5});
 }
}

export async function* immutableFeedDocumentsForPlan(db,{tenantId,fromSequence,checkpointSequence,budget,pageSize=100}){
 id(tenantId);integer(fromSequence,0,Number.MAX_SAFE_INTEGER);integer(checkpointSequence,fromSequence,Number.MAX_SAFE_INTEGER);integer(pageSize,1,100);
 if(!budget?.reserve)throw new Error('archive-budget-required');let after=fromSequence;
 while(after<checkpointSequence){
  await budget.reserve({tenantId,stepId:`prune_source_${after}`,costs:{firestoreReads:pageSize+1}});
  const docs=(await db.doc(`tenants/${tenantId}`).collection('changes').where('sequence','>',after).where('sequence','<=',checkpointSequence).orderBy('sequence').limit(pageSize).get()).docs;
  if(!docs.length)throw new Error('prune-source-gap');
  for(const doc of docs){const data=doc.data();if(data.sequence!==after+1||data.sequence>checkpointSequence)throw new Error('prune-source-gap');after=data.sequence;
   yield {id:doc.id,data,updateTime:version({seconds:doc.updateTime.seconds,nanoseconds:doc.updateTime.nanoseconds})};
  }
 }
}
