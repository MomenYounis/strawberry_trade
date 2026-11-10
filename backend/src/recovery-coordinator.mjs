// Local, disabled recovery orchestration and isolated demo activation.
// Never accepts a live cloud target or production override.
import {createHash,randomBytes} from 'node:crypto';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {canonical,integer,id} from './validation.mjs';
import {DEMO_PROJECT_ID,assertDemoOperatorEnvironment} from './demo-operator.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {decodeRecoveryFields,freezeRecoveryValue,FIRESTORE_RECOVERY_LIMITS} from './firestore-recovery-source.mjs';
import {verifyFirestoreRecoveryImage} from './firestore-recovery-image.mjs';
import {TENANT_RECOVERY_COLLECTIONS} from './tenant-recovery-quarantine.mjs';
import {openRecoveryAuthorityPackage,authorityDigest,AUTHORITY_RECOVERY_LIMITS} from './recovery-authority-package.mjs';
import {createRecoveryAuthorityDemoTarget} from './recovery-authority-demo.mjs';
import {prepareImageBoundRecoveryAuthority,restorePreparedImageBoundAuthority,disposeImageBoundRecoveryAuthority} from './recovery-authority-binding.mjs';
import {prepareRecoveryObjectCopy,copyRecoveryObjects,verifyRecoveryObjectDestination} from './recovery-object-copy.mjs';
import {openRecoveryObjectLocalStorage} from './recovery-object-local-storage.mjs';
import {openRecoveryObjectLocalJournal} from './recovery-object-journal.mjs';
import {restoreFirestoreRecoveryQuarantine} from './firestore-recovery-quarantine.mjs';
import {readArchiveManifest} from './archive-format.mjs';
import {validateSnapshotHeader,validateSnapshotPage,snapshotHash,snapshotContentHash} from './active-snapshot-format.mjs';

export const RECOVERY_COORDINATOR_LIMITS=Object.freeze({runtimeMs:1_800_000,requestMs:10_000,readBytes:8_388_608,totalReadBytes:8_589_934_592,requests:300_000,keyIds:256});
export const PROVIDER_RECOVERY_VERIFICATION_BLOCKERS=Object.freeze([
 'provider-scrypt-signer-parameters-and-live-password-signin-unverified',
 'provider-kms-or-hardware-key-custody-unverified',
 'provider-pitr-consistent-export-and-object-bucket-lock-unverified',
]);
export const RECOVERY_DATA_CLASSIFICATION=Object.freeze({
 serverRecoverable:Object.freeze([
  'accepted_ledger_entries_and_sequence_history',
  'accepted_operation_receipts_and_idempotency_records',
  'parties_members_roles_and_tenant_root_metadata',
  'audit_trail_and_top_level_operator_administration_history',
  'immutable_annual_archive_manifests_and_encrypted_chunks',
  'active_snapshot_manifests_and_pages',
  'firebase_auth_uid_email_custom_claims_and_scrypt_password_hashes',
 ]),
 requiresEncryptedPendingBackup:Object.freeze([
  'unsynced_pending_outbox_operations_with_original_id_and_payload_hash',
  'unfinished_local_invoice_or_operation_drafts',
 ]),
 lostWithoutDeviceOrBackup:Object.freeze([
  'unbacked_up_local_outbox_operations_never_acknowledged_by_server',
  'unbacked_up_local_drafts_and_local_only_ui_preferences',
  'hardware_bound_device_private_signing_key_requiring_device_transfer_or_reenrollment',
 ]),
});
export function describeRecoveryDataScope(){return freezeRecoveryValue(RECOVERY_DATA_CLASSIFICATION);}

const collections=['$root',...TENANT_RECOVERY_COLLECTIONS],emptyHash=createHash('sha256').digest('hex'),hex=/^[a-f0-9]{64}$/;
const quarantinePhases=['preflight','objects','financial','authority','verifying','verified_disabled_recovery'];
const activationPhases=['activating_preflight','activating_objects','activating_financial','activating_authority','activating_verifying','activated_demo_recovery'];
const allPhases=[...quarantinePhases,...activationPhases];
const plans=new WeakMap(),targets=new WeakMap(),busy=new WeakSet();
const fail=reason=>{throw Error('recovery-coordinator-'+reason);};
const sha=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonical(value)).digest('hex');
const web=value=>Buffer.from(value).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
const blankCounts=()=>Object.fromEntries(collections.map(name=>[name,0]));

function exact(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('schema');for(const key of keys)if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))fail('data-properties');}
function selectLimits(options={}){if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).some(key=>!Object.hasOwn(RECOVERY_COORDINATOR_LIMITS,key)))fail('limits');const result={...RECOVERY_COORDINATOR_LIMITS,...options};for(const [key,max]of Object.entries(RECOVERY_COORDINATOR_LIMITS))integer(result[key],1,max);return Object.freeze(result);}
function ownedBytes(value,max,size=null){if(!(value instanceof Uint8Array)||value.length<1||value.length>max||size!==null&&value.length!==size||typeof SharedArrayBuffer!=='undefined'&&value.buffer instanceof SharedArrayBuffer)fail('bytes');return Buffer.from(value);}
function clockBudget(limits){const started=performance.now();let requests=0,readBytes=0;
 function remaining(){const left=Math.floor(limits.runtimeMs-(performance.now()-started));if(left<1)fail('runtime');return left;}
 async function run(action){remaining();if(++requests>limits.requests)fail('requests');const controller=new AbortController();let timer;try{const value=await Promise.race([Promise.resolve().then(()=>{remaining();return action(controller.signal);}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('recovery-coordinator-deadline'));},Math.min(limits.requestMs,remaining()));})]);remaining();return value;}finally{clearTimeout(timer);controller.abort();}}
 function reader(storage){if(typeof storage?.read!=='function')fail('source-storage');const read=storage.read.bind(storage);return Object.freeze({async read(key,{maxBytes}){integer(maxBytes,1,limits.readBytes);if(readBytes+maxBytes>limits.totalReadBytes)fail('read-bytes');const value=ownedBytes(await run(signal=>read(key,{maxBytes,signal})),maxBytes);readBytes+=value.length;if(readBytes>limits.totalReadBytes)fail('read-bytes');return value;}});}
 return {remaining,run,reader,statistics:()=>({requests,readBytes,elapsedMs:Math.ceil(performance.now()-started)})};
}

// This factory delegates the strict process/environment/credential guard before
// constructing either private client. Callers cannot inject a target database.
export function createRecoveryCoordinatorDemoTarget({credential,environment=process.env}){
 const authority=createRecoveryAuthorityDemoTarget({credential,environment});let app;
 try{
  app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert(credential)},'recovery-coordinator-'+randomBytes(12).toString('hex'));
  const db=initializeFirestore(app,{preferRest:true});db.settings({host:'127.0.0.1:18180',ssl:false,...emulatorFirestoreSettings(DEMO_PROJECT_ID,environment)});
  let closed=false;const target=Object.freeze({kind:'demo-only-disabled-recovery-coordinator',projectId:DEMO_PROJECT_ID,async close(){if(closed)return;if(busy.has(target))fail('target-busy');closed=true;targets.delete(target);try{await authority.close();}finally{await deleteApp(app);}}});
  targets.set(target,{authority,db,environment,check(){for(const current of [environment,process.env]){assertDemoOperatorEnvironment(DEMO_PROJECT_ID,current);if(current.GOOGLE_APPLICATION_CREDENTIALS||current.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18180'||current.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:19199')fail('target-environment');}const settings=db._settings,local=settings.host==='127.0.0.1:18180'||settings.servicePath==='127.0.0.1'&&settings.port===18180;if(closed||db.projectId!==DEMO_PROJECT_ID||db.databaseId!=='(default)'||!local||settings.ssl!==false)fail('target');}});return target;
 }catch(error){void authority.close().catch(()=>{});if(app)void deleteApp(app).catch(()=>{});throw error;}
}

export async function prepareRecoveryCoordinator({image,authorityEnvelope,authorityMasterKey,objects,limits={}}){
 const selected=selectLimits(limits),guard=clockBudget(selected);exact(image,['storage','manifestKey','manifestSha256','masterKey','expected']);exact(image.expected,['projectId','databaseId','tenantId','readTime','imageId','keyId']);exact(objects,['sourceStorage','resolveArchiveKey']);if(typeof objects.resolveArchiveKey!=='function')fail('key-resolver');
 const expected=freezeRecoveryValue({...image.expected}),sourceStorage=guard.reader(objects.sourceStorage),resolveKey=objects.resolveArchiveKey.bind(objects),sourceDirectory=objects.sourceStorage.directory??null,imageDirectory=image.storage.directory??null;
 let imageKey,envelope,authorityKey,imageCopy,authorityPlan,retained=false;const keys=new Map();
 try{
  imageKey=ownedBytes(image.masterKey,32,32);envelope=ownedBytes(authorityEnvelope,AUTHORITY_RECOVERY_LIMITS.envelopeBytes);authorityKey=ownedBytes(authorityMasterKey,32,32);imageCopy=Object.freeze({storage:guard.reader(image.storage),manifestKey:image.manifestKey,manifestSha256:image.manifestSha256,masterKey:imageKey,expected});
  authorityPlan=await prepareImageBoundRecoveryAuthority({image:imageCopy,authorityEnvelope:envelope,authorityMasterKey:authorityKey,limits:{runtimeMs:guard.remaining(),requestMs:selected.requestMs}});guard.remaining();
  const objectPlan=await prepareRecoveryObjectCopy({image:imageCopy,sourceStorage,resolveArchiveKey:async keyId=>{id(keyId);if(!keys.has(keyId)){if(keys.size>=selected.keyIds)fail('key-count');keys.set(keyId,ownedBytes(await guard.run(()=>resolveKey(keyId)),32,32));}return keys.get(keyId);},limits:{runtimeMs:guard.remaining(),requestMs:selected.requestMs}});guard.remaining();
  if(objectPlan.imageManifestSha256!==authorityPlan.imageManifestSha256)fail('image-binding');
  const binding={format:'strawberry-disabled-recovery-coordinator',version:1,targetProjectId:DEMO_PROJECT_ID,context:authorityPlan.context,imageManifestSha256:authorityPlan.imageManifestSha256,authorityPackageSha256:authorityPlan.authorityPackageSha256,objectCopyPlanSha256:objectPlan.copyPlanSha256,uidInventorySha256:authorityPlan.uidInventorySha256,activationAllowed:false,productionRecoveryAccepted:false};
  const plan=freezeRecoveryValue({...binding,coordinatorPlanSha256:authorityDigest(binding),users:authorityPlan.users,operatorRecords:authorityPlan.operatorRecords,objectCount:objectPlan.objectCount,objectBytes:objectPlan.totalBytes});
  plans.set(plan,{image:imageCopy,envelope,authorityKey,imageKey,authorityPlan,objectPlan,keys,guard,selected,sourceDirectory,imageDirectory,active:false});retained=true;return plan;
 }finally{if(!retained){if(authorityPlan)disposeImageBoundRecoveryAuthority(authorityPlan);imageKey?.fill(0);envelope?.fill(0);authorityKey?.fill(0);for(const key of keys.values())key.fill(0);}}
}

export function disposeRecoveryCoordinator(plan){const state=plans.get(plan);if(!state)return false;if(state.active)fail('plan-busy');disposeImageBoundRecoveryAuthority(state.authorityPlan);state.imageKey.fill(0);state.envelope.fill(0);state.authorityKey.fill(0);for(const key of state.keys.values())key.fill(0);plans.delete(plan);return true;}
function optionsFor(options={}){const defaults={objects:40_000,batches:25_001,users:1000,operatorRecords:5000};if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).some(key=>!Object.hasOwn(defaults,key)))fail('budgets');const result={...defaults,...options};for(const [key,max]of Object.entries(defaults))integer(result[key],1,max);return result;}
function progressValue(plan,destinationDirectory,phase){return {format:'strawberry-disabled-recovery-progress',version:1,coordinatorPlanSha256:plan.coordinatorPlanSha256,destinationDirectory,phase,activationAllowed:false,productionRecoveryAccepted:false};}
function progressCheck(value,plan,destinationDirectory,allowed=quarantinePhases){exact(value,Object.keys(progressValue(plan,destinationDirectory,'preflight')));if(!allowed.includes(value.phase)||canonical(value)!==canonical(progressValue(plan,destinationDirectory,value.phase)))fail('journal-binding');}
function verified(value){if(value?.state!=='verified_quarantine'||value.activationAllowed!==false||value.productionRecoveryAccepted!==false)fail('layer-not-verified');}

export async function restorePreparedRecoveryCoordinator({target,plan,destinationDirectory,journalDirectory,budgets={},afterPhase=async()=>{}}){
 const state=plans.get(plan),handle=targets.get(target);if(!state||state.active)fail('prepared-plan');if(!handle||busy.has(target))fail('owned-target');const selected=optionsFor(budgets);if(typeof afterPhase!=='function')fail('hook');state.guard.remaining();handle.check();state.active=true;busy.add(target);let journal;
 try{
  const destination=await openRecoveryObjectLocalStorage({directory:destinationDirectory});state.guard.remaining();if(destination.directory===state.sourceDirectory||destination.directory===state.imageDirectory)fail('source-is-destination');
  journal=await openRecoveryObjectLocalJournal({directory:journalDirectory});state.guard.remaining();
  const destinationIO={read:state.guard.reader(destination).read,async putImmutable(key,value){state.guard.remaining();const body=ownedBytes(value,state.selected.readBytes);let dispatched=false;try{return await state.guard.run(()=>{state.guard.remaining();dispatched=true;const pending=Promise.resolve().then(()=>destination.putImmutable(key,body));pending.then(()=>body.fill(0),()=>body.fill(0));return pending;});}finally{if(!dispatched)body.fill(0);}}};
  const objectJournal={load:key=>state.guard.run(()=>journal.load(key)),compareAndSwap:(...args)=>state.guard.run(()=>journal.compareAndSwap(...args))};
  const runKey=authorityDigest({format:'strawberry-disabled-recovery-run',coordinatorPlanSha256:plan.coordinatorPlanSha256,destinationDirectory:destination.directory});let progress=await objectJournal.load(runKey);if(progress)progressCheck(progress,plan,destination.directory,quarantinePhases);
  async function checkpoint(phase){state.guard.remaining();handle.check();const next=progressValue(plan,destination.directory,phase);await objectJournal.compareAndSwap(runKey,progress,next);progress=next;}
  async function notify(phase){await state.guard.run(()=>afterPhase(Object.freeze({phase,coordinatorPlanSha256:plan.coordinatorPlanSha256,activationAllowed:false,productionRecoveryAccepted:false})));}
  function result(phase,complete,components){return freezeRecoveryValue({format:'strawberry-disabled-recovery-result',version:1,state:complete?'verified_disabled_recovery':'staging',phase,coordinatorPlanSha256:plan.coordinatorPlanSha256,imageManifestSha256:plan.imageManifestSha256,authorityPackageSha256:plan.authorityPackageSha256,objectCopyPlanSha256:plan.objectCopyPlanSha256,uidInventorySha256:plan.uidInventorySha256,runJournalKey:runKey,enabled:false,activationAllowed:false,productionRecoveryAccepted:false,atomicLiveRecovery:false,independentProviderAcceptance:false,...components,...state.guard.statistics()});}
  await checkpoint('preflight');
  const objects=await copyRecoveryObjects({plan:state.objectPlan,destinationStorage:destinationIO,journal:objectJournal,maxObjectsPerInvocation:selected.objects});state.guard.remaining();
  if(!objects.complete)return result('objects',false,{objects});await checkpoint('objects');await notify('objects');
  const financial=await restoreFirestoreRecoveryQuarantine({db:handle.db,environment:handle.environment,...state.image,maxBatches:selected.batches,maxRuntimeMs:state.guard.remaining()});state.guard.remaining();
  if(financial.state!=='verified_quarantine')return result('financial',false,{objects,financial});verified(financial);await checkpoint('financial');await notify('financial');
  const authority=await restorePreparedImageBoundAuthority({target:handle.authority,plan:state.authorityPlan,restoreOptions:{maxUsers:selected.users,maxOperatorRecords:selected.operatorRecords,maxRuntimeMs:state.guard.remaining()}});state.guard.remaining();
  if(authority.state!=='verified_quarantine')return result('authority',false,{objects,financial,authority});verified(authority);await checkpoint('authority');await notify('authority');
  // Completion flags never skip verification. Reauthenticate the source and
  // reread all three disabled destinations, even after a completed run resumes.
  await checkpoint('verifying');
  const financialFinal=await restoreFirestoreRecoveryQuarantine({db:handle.db,environment:handle.environment,...state.image,maxRuntimeMs:state.guard.remaining()});state.guard.remaining();verified(financialFinal);
  const freshAuthority=await prepareImageBoundRecoveryAuthority({image:state.image,authorityEnvelope:state.envelope,authorityMasterKey:state.authorityKey,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});
  let authorityFinal;try{authorityFinal=await restorePreparedImageBoundAuthority({target:handle.authority,plan:freshAuthority,restoreOptions:{maxRuntimeMs:state.guard.remaining()}});}finally{disposeImageBoundRecoveryAuthority(freshAuthority);}state.guard.remaining();verified(authorityFinal);
  const objectFinal=await verifyRecoveryObjectDestination({plan:state.objectPlan,destinationStorage:destinationIO,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});state.guard.remaining();if(objectFinal.byteIntegrityVerified!==true||objectFinal.activationAllowed!==false||objectFinal.productionRecoveryAccepted!==false)fail('object-verification');
  await checkpoint('verified_disabled_recovery');return result('complete',true,{objects:objectFinal,financial:financialFinal,authority:authorityFinal,allLayerTargetsVerified:true});
 }finally{try{await journal?.close();}finally{state.active=false;busy.delete(target);disposeRecoveryCoordinator(plan);}}
}

export async function restoreRecoveryCoordinatorDemo({target,image,authorityEnvelope,authorityMasterKey,objects,destinationDirectory,journalDirectory,limits,budgets,afterPhase}){
 if(!targets.has(target))fail('owned-target');const plan=await prepareRecoveryCoordinator({image,authorityEnvelope,authorityMasterKey,objects,limits});
 try{return await restorePreparedRecoveryCoordinator({target,plan,destinationDirectory,journalDirectory,budgets,afterPhase});}finally{if(plans.has(plan))disposeRecoveryCoordinator(plan);}
}

function quarantineTargetValue(row,context){
 const common={sourceProjectId:context.projectId,sourceDatabaseId:context.databaseId,sourceTenantId:context.tenantId,sourceMetadata:row.source,sourceRecordSha256:sha(row)};
 return row.collection==='$root'?{format:'firestore-recovery-quarantine-root-v1',enabled:false,activationAllowed:false,...common,sourceRoot:row.payload}
  :{format:'firestore-recovery-quarantine-record-v1',...common,payload:row.payload};
}
function equalBase64(raw,wanted){if(typeof raw!=='string')return false;return Buffer.from(raw,'base64').equals(Buffer.from(wanted,'base64'));}
function expectedClaims(u){return u.customAttributes?JSON.parse(u.customAttributes):{};}
function isQuarantinedUser(user,u){return user?.uid===u.localId&&user.email?.toLowerCase()===u.email.toLowerCase()&&user.emailVerified===u.emailVerified&&user.disabled===true&&!user.phoneNumber&&!(user.mfaInfo??[]).length&&(user.displayName??'')===(u.displayName??'')&&(user.photoURL??'')===(u.photoUrl??'')&&Object.keys(user.customClaims??{}).length===0&&(user.providerData??[]).every(p=>p.providerId==='password')&&equalBase64(user.passwordHash,u.passwordHash)&&equalBase64(user.passwordSalt,u.salt);}
function isActivatedUser(user,u){return user?.uid===u.localId&&user.email?.toLowerCase()===u.email.toLowerCase()&&user.emailVerified===u.emailVerified&&user.disabled===Boolean(u.disabled)&&!user.phoneNumber&&!(user.mfaInfo??[]).length&&(user.displayName??'')===(u.displayName??'')&&(user.photoURL??'')===(u.photoUrl??'')&&canonical(user.customClaims??{})===canonical(expectedClaims(u))&&(user.providerData??[]).every(p=>p.providerId==='password')&&equalBase64(user.passwordHash,u.passwordHash)&&equalBase64(user.passwordSalt,u.salt);}

function activationJournalBlank(plan,destinationDirectory){
 return {
  format:'strawberry-demo-recovery-activation-v1',
  version:1,
  coordinatorPlanSha256:plan.coordinatorPlanSha256,
  imageManifestSha256:plan.imageManifestSha256,
  authorityPackageSha256:plan.authorityPackageSha256,
  objectCopyPlanSha256:plan.objectCopyPlanSha256,
  uidInventorySha256:plan.uidInventorySha256,
  destinationDirectory,
  context:plan.context,
  state:'activating',
  objectsVerified:0,
  financialRecords:0,
  financialBytes:0,
  financialPrefixSha256:emptyHash,
  financialLastPath:'',
  financialCounts:blankCounts(),
  verifiedFinancialSha256:'',
  owner:'',
  leaseUntilMs:0,
 };
}
function checkActivationJournal(j,plan,destinationDirectory){
 const template=activationJournalBlank(plan,destinationDirectory);
 exact(j,Object.keys(template));
 if(j.format!==template.format||j.version!==1||j.coordinatorPlanSha256!==plan.coordinatorPlanSha256||j.imageManifestSha256!==plan.imageManifestSha256||j.authorityPackageSha256!==plan.authorityPackageSha256||j.objectCopyPlanSha256!==plan.objectCopyPlanSha256||j.uidInventorySha256!==plan.uidInventorySha256||j.destinationDirectory!==destinationDirectory||canonical(j.context)!==canonical(plan.context)||!['activating','activated_demo_recovery'].includes(j.state)||typeof j.owner!=='string'||!/^(?:[a-f0-9]{48})?$/.test(j.owner)||!Number.isSafeInteger(j.leaseUntilMs)||j.leaseUntilMs<0)fail('activation-journal-conflict');
 integer(j.objectsVerified,0,plan.objectCount);integer(j.financialRecords,0,FIRESTORE_RECOVERY_LIMITS.records);integer(j.financialBytes,0,FIRESTORE_RECOVERY_LIMITS.totalBytes);exact(j.financialCounts,collections);
 for(const count of Object.values(j.financialCounts))integer(count,0,FIRESTORE_RECOVERY_LIMITS.records);
 if(Object.values(j.financialCounts).reduce((a,b)=>a+b,0)!==j.financialRecords||j.financialCounts.$root!==(j.financialRecords?1:0)||typeof j.financialLastPath!=='string'||j.financialLastPath.length>250||!hex.test(j.financialPrefixSha256)||(!j.financialRecords&&(j.financialBytes!==0||j.financialLastPath!==''||j.financialPrefixSha256!==emptyHash))||(j.verifiedFinancialSha256!==''&&j.verifiedFinancialSha256!==j.financialPrefixSha256)||(j.state==='activated_demo_recovery'&&(j.objectsVerified!==plan.objectCount||j.verifiedFinancialSha256===''||j.owner!==''||j.leaseUntilMs!==0)))fail('activation-journal-progress');
}

async function verifyDestinationArchiveAndSnapshotObjects({state,destinationIO}){
 const catalogRef=state.objectPlan.roots;
 for(const root of catalogRef)if(!root?.key||!hex.test(root.sha256))fail('object-verification');
 const closureRaw=await destinationIO.read(`recovery-objects/v1/${state.objectPlan.source.tenantId}/closures/${state.objectPlan.closureSha256}`,{maxBytes:state.selected.readBytes});
 const closure=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(closureRaw));
 if(!Array.isArray(closure.objects))fail('object-verification');
 const byKey=new Map(closure.objects.map(item=>[item.key,item]));
 for(const item of closure.objects){
  if(item.key.includes('/archives/v1/')&&item.key.includes('/manifests/')||item.key.startsWith('archives/v1/')&&item.key.includes('/manifests/')){
   const match=/^archives\/v1\/([A-Za-z0-9_-]{1,120})\/([0-9]{4})\/([A-Za-z0-9_-]{1,120})\/manifests\/([a-f0-9]{64})$/.exec(item.key);
   if(!match||item.keyIds?.length!==1)fail('object-verification');
   const keyId=item.keyIds[0],masterKey=state.keys.get(keyId);if(!masterKey)fail('object-verification');
   const manifest=await readArchiveManifest({storage:destinationIO,manifestKey:item.key,manifestSha256:item.sha256,masterKey,expected:{tenantId:match[1],year:Number(match[2]),runId:match[3],keyId}});
   for(const chunk of manifest.chunks){const child=byKey.get(chunk.key);if(!child||child.sha256!==chunk.cipherSha256||child.bytes!==chunk.cipherBytes)fail('object-verification');}
  }else if(item.key.startsWith('snapshots/v1/')&&item.key.includes('/manifests/')){
   const match=/^snapshots\/v1\/([A-Za-z0-9_-]{1,120})\/([A-Za-z0-9_-]{1,120})\/manifests\/([a-f0-9]{64})$/.exec(item.key);
   if(!match)fail('object-verification');
   const pubBytes=await destinationIO.read(item.key,{maxBytes:item.bytes}),pub=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pubBytes));
   const header=validateSnapshotHeader(pub.header,{tenantId:match[1],snapshotId:match[2]});
   if(snapshotHash(header)!==pub.headerSha256||snapshotContentHash(pub.pages)!==header.contentSha256)fail('object-verification');
   for(const [index,pageDesc]of pub.pages.entries()){
    const child=byKey.get(pageDesc.key);if(!child)fail('object-verification');
    const pageBytes=await destinationIO.read(pageDesc.key,{maxBytes:child.bytes}),page=validateSnapshotPage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pageBytes)),header,index);
    if(page.sha256!==pageDesc.sha256||page.records.length!==pageDesc.recordCount)fail('object-verification');
   }
  }
 }
}

export async function activatePreparedRecoveryCoordinator({target,plan,destinationDirectory,journalDirectory,budgets={},afterPhase=async()=>{}}){
 const state=plans.get(plan),handle=targets.get(target);if(!state||state.active)fail('prepared-plan');if(!handle||busy.has(target))fail('owned-target');const selected=optionsFor(budgets);if(typeof afterPhase!=='function')fail('hook');state.guard.remaining();handle.check();state.active=true;busy.add(target);
 let journal,leaseAcquired=false,uncertainAuthWrite=false,leaseUntilMs=0;const owner=randomBytes(24).toString('hex');
 try{
  const destination=await openRecoveryObjectLocalStorage({directory:destinationDirectory});state.guard.remaining();if(destination.directory===state.sourceDirectory||destination.directory===state.imageDirectory)fail('source-is-destination');
  journal=await openRecoveryObjectLocalJournal({directory:journalDirectory});state.guard.remaining();
  const destinationIO={read:state.guard.reader(destination).read};
  const objectJournal={load:key=>state.guard.run(()=>journal.load(key)),compareAndSwap:(...args)=>state.guard.run(()=>journal.compareAndSwap(...args))};
  const runKey=authorityDigest({format:'strawberry-disabled-recovery-run',coordinatorPlanSha256:plan.coordinatorPlanSha256,destinationDirectory:destination.directory});
  let progress=await objectJournal.load(runKey);
  if(!progress)fail('quarantine-not-verified');
  progressCheck(progress,plan,destination.directory,['verified_disabled_recovery',...activationPhases]);
  const context=plan.context,db=handle.db,actRef=db.doc('recoveryCoordinatorActivations/'+context.imageId),liveRoot=db.doc('tenants/'+context.tenantId),quarantineJournal=db.doc('firestoreRecoveryQuarantine/'+context.imageId),quarantineRoot=quarantineJournal.collection('tenants').doc(context.tenantId),authorityQuarantineRoot=db.doc('authorityRecoveryQuarantine/'+context.imageId);
  let wireBytes=0,restRequests=0;
  async function firestoreRest(path,{body,query={}}={}){
   state.guard.remaining();handle.check();if(++restRequests>FIRESTORE_RECOVERY_LIMITS.requests)fail('inventory-request-limit');
   const url=new URL(`http://${handle.environment.FIRESTORE_EMULATOR_HOST}/v1/projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${path}`);
   if(!body)url.search=new URLSearchParams(query).toString();
   return state.guard.run(async signal=>{
    const response=await fetch(url,{method:body?'POST':'GET',headers:{authorization:'Bearer owner',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal});
    if(!response.ok){await response.body?.cancel().catch(()=>{});fail('inventory-http');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;wireBytes+=value.length;if(size>1_048_576||wireBytes>FIRESTORE_RECOVERY_LIMITS.wireBytes)fail('inventory-byte-limit');chunks.push(Buffer.from(value));state.guard.remaining();}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('inventory-json');}
   });
  }
  async function childCollections(path){
   const result=await firestoreRest(path+':listCollectionIds',{body:{pageSize:TENANT_RECOVERY_COLLECTIONS.length+5}});
   if(!Array.isArray(result.collectionIds??[])||result.nextPageToken)fail('inventory-collection-limit');
   return (result.collectionIds??[]).sort();
  }
  async function authRequest(kind,body){
   state.guard.remaining();handle.check();
   const paths={lookup:'projects/'+DEMO_PROJECT_ID+'/accounts:lookup',import:'projects/'+DEMO_PROJECT_ID+'/accounts:batchCreate'};
   if(!Object.hasOwn(paths,kind))fail('auth-endpoint');
   const raw=JSON.stringify(body);if(Buffer.byteLength(raw)>65_536)fail('auth-request-byte-limit');
   return state.guard.run(async signal=>{
    let response;try{response=await fetch('http://127.0.0.1:19199/identitytoolkit.googleapis.com/v1/'+paths[kind],{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:raw,redirect:'error',signal});}catch{fail('auth-request-ambiguous');}
    if(!response.body)fail('auth-response');const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1_048_576)fail('auth-response-byte-limit');chunks.push(Buffer.from(value));state.guard.remaining();}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!response.ok){const e=Error('recovery-coordinator-auth-rejected');e.definitiveAuthRejection=true;throw e;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('auth-response-json');}
   });
  }
  async function authLookup(selector){
   const value=await authRequest('lookup',selector);if(!Array.isArray(value.users??[])||(value.users??[]).length>1)fail('auth-lookup-cardinality');
   if(!value.users?.length)return null;const u=value.users[0];
   let claims={};try{if(u.customAttributes!==undefined)claims=JSON.parse(u.customAttributes);}catch{fail('auth-claims');}
   return {uid:u.localId,email:u.email,emailVerified:u.emailVerified===true,disabled:u.disabled===true,displayName:u.displayName,photoURL:u.photoUrl,passwordHash:u.passwordHash,passwordSalt:u.salt,phoneNumber:u.phoneNumber,mfaInfo:u.mfaInfo??[],customClaims:claims,providerData:(u.providerUserInfo??[]).map(p=>({providerId:p.providerId}))};
  }
  async function authActivateUser(u,hashSpec){
   const keyBuf=Buffer.from(hashSpec.key,'base64'),saltSepBuf=Buffer.from(hashSpec.saltSeparator,'base64'),passBuf=Buffer.from(u.passwordHash,'base64'),saltBuf=Buffer.from(u.salt,'base64');
   try{
    const record={localId:u.localId,email:u.email,emailVerified:u.emailVerified,disabled:Boolean(u.disabled),displayName:u.displayName??'',customAttributes:u.customAttributes??'{}',providerUserInfo:[],mfaInfo:[],passwordHash:web(passBuf),salt:web(saltBuf)};
    if(u.photoUrl)record.photoUrl=u.photoUrl;if(u.createdAt!==undefined)record.createdAt=String(Number(u.createdAt));if(u.lastSignedInAt!==undefined)record.lastLoginAt=String(Number(u.lastSignedInAt));
    const res=await authRequest('import',{hashAlgorithm:hashSpec.algorithm,signerKey:web(keyBuf),saltSeparator:web(saltSepBuf),rounds:hashSpec.rounds,memoryCost:hashSpec.memoryCost,users:[record],sanityCheck:true,allowOverwrite:true});
    if((res.error??[]).length)fail('auth-activate-failed');
   }finally{keyBuf.fill(0);saltSepBuf.fill(0);passBuf.fill(0);saltBuf.fill(0);}
  }
  async function checkpoint(phase){state.guard.remaining();handle.check();const next=progressValue(plan,destination.directory,phase);await objectJournal.compareAndSwap(runKey,progress,next);progress=next;}
  async function notify(phase){await state.guard.run(()=>afterPhase(Object.freeze({phase,coordinatorPlanSha256:plan.coordinatorPlanSha256,activationAllowed:false,productionRecoveryAccepted:false})));}
  async function currentAct(tx){
   state.guard.remaining();handle.check();if(leaseAcquired&&Date.now()>=leaseUntilMs)fail('lease-local-deadline');
   const snap=await tx.get(actRef),j=snap.data();if(!j)fail('activation-journal-missing');
   checkActivationJournal(j,plan,destination.directory);
   if(j.owner!==owner||j.leaseUntilMs<snap.readTime.toMillis())fail('activation-lease-lost');
   return j;
  }
  async function fenceAct(){await state.guard.run(()=>db.runTransaction(async tx=>{await currentAct(tx);},{maxAttempts:1}));}
  function result(phase,complete,components){
   return freezeRecoveryValue({
    format:'strawberry-demo-recovery-activation-result',
    version:1,
    state:complete?'activated_demo_recovery':'activating',
    phase,
    coordinatorPlanSha256:plan.coordinatorPlanSha256,
    imageManifestSha256:plan.imageManifestSha256,
    authorityPackageSha256:plan.authorityPackageSha256,
    objectCopyPlanSha256:plan.objectCopyPlanSha256,
    uidInventorySha256:plan.uidInventorySha256,
    runJournalKey:runKey,
    tenantId:context.tenantId,
    enabled:complete,
    operationalTenantActivated:complete,
    quarantinePreserved:true,
    activationAllowed:false,
    productionRecoveryAccepted:false,
    atomicLiveRecovery:false,
    independentProviderAcceptance:false,
    providerVerificationBlockers:PROVIDER_RECOVERY_VERIFICATION_BLOCKERS,
    recoveryScope:RECOVERY_DATA_CLASSIFICATION,
    ...components,
    ...state.guard.statistics(),
   });
  }

  const authorityPayload=openRecoveryAuthorityPackage({envelope:state.envelope,masterKey:state.authorityKey,expected:context});
  const existingActSnap=await state.guard.run(()=>actRef.get());
  if(!existingActSnap.exists){
   if(progress.phase!=='verified_disabled_recovery')fail('activation-journal-missing');
   // Complete read-only preflight before creating the activation journal or any live document.
   const objectPre=await verifyRecoveryObjectDestination({plan:state.objectPlan,destinationStorage:destinationIO,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});
   if(objectPre.byteIntegrityVerified!==true)fail('object-verification');
   const financialPre=await restoreFirestoreRecoveryQuarantine({db,environment:handle.environment,...state.image,maxRuntimeMs:state.guard.remaining()});
   verified(financialPre);
   const freshAuthPlan=await prepareImageBoundRecoveryAuthority({image:state.image,authorityEnvelope:state.envelope,authorityMasterKey:state.authorityKey,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});
   try{const authPre=await restorePreparedImageBoundAuthority({target:handle.authority,plan:freshAuthPlan,restoreOptions:{maxRuntimeMs:state.guard.remaining()}});verified(authPre);}finally{disposeImageBoundRecoveryAuthority(freshAuthPlan);}
   if((await state.guard.run(()=>liveRoot.get())).exists||(await childCollections(liveRoot.path)).length)fail('live-target-collision');
   for(const row of authorityPayload.operatorRecords){if((await state.guard.run(()=>db.doc(row.path).get())).exists)fail('live-operator-collision');}
   for(const u of authorityPayload.users){const found=await authLookup({localId:[u.localId]}),byEmail=await authLookup({email:[u.email]});if(!isQuarantinedUser(found,u)||byEmail?.uid!==u.localId)fail('auth-quarantine-tampered');}
  }else{
   checkActivationJournal(existingActSnap.data(),plan,destination.directory);
  }

  let actState=await state.guard.run(()=>db.runTransaction(async tx=>{
   const snap=await tx.get(actRef),old=snap.data(),time=snap.readTime.toMillis();
   if(old){
    checkActivationJournal(old,plan,destination.directory);
    if(old.owner&&old.leaseUntilMs>time)fail('active-lease');
    leaseUntilMs=time+state.guard.remaining()+30_000;
    const next={...old,state:'activating',owner,leaseUntilMs};
    tx.set(actRef,next);return next;
   }
   const liveSnap=await tx.get(liveRoot);if(liveSnap.exists)fail('live-target-collision');
   leaseUntilMs=time+state.guard.remaining()+30_000;
   const created={...activationJournalBlank(plan,destination.directory),owner,leaseUntilMs};
   tx.create(actRef,created);return created;
  },{maxAttempts:1}));
  leaseAcquired=true;
  await checkpoint('activating_preflight');

  // Layer 1: Verify destination objects, archive manifests, and snapshot pages from destination storage.
  const objectVerify=await verifyRecoveryObjectDestination({plan:state.objectPlan,destinationStorage:destinationIO,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});
  if(objectVerify.byteIntegrityVerified!==true)fail('object-verification');
  await verifyDestinationArchiveAndSnapshotObjects({state,destinationIO});
  if(actState.objectsVerified<plan.objectCount){
   const nextObjects=Math.min(plan.objectCount,actState.objectsVerified+selected.objects);
   actState=await state.guard.run(()=>db.runTransaction(async tx=>{
    const cur=await currentAct(tx),next={...cur,objectsVerified:nextObjects};tx.set(actRef,next);return next;
   },{maxAttempts:1}));
   if(actState.objectsVerified<plan.objectCount)return result('activating_objects',false,{objects:{verifiedObjects:actState.objectsVerified,totalObjects:plan.objectCount}});
  }
  await checkpoint('activating_objects');await notify('activating_objects');

  // Layer 2: Promote verified financial quarantine records into live tenants/<tenantId>.
  const qJournalSnap=await state.guard.run(()=>quarantineJournal.get());
  if(!qJournalSnap.exists||qJournalSnap.data()?.state!=='verified_quarantine'||qJournalSnap.data()?.manifestSha256!==plan.imageManifestSha256)fail('quarantine-tampered');
  const prefixRecords=actState.financialRecords,digest=createHash('sha256'),counts=blankCounts();
  let records=0,recordBytes=0,lastPath='',pending=[],pendingBytes=0,batches=0,stoppedFinancial=false;
  const budgetBreak=Symbol('coordinator-financial-budget');
  const liveRef=row=>row.collection==='$root'?liveRoot:liveRoot.collection(row.collection).doc(row.id);
  const qRef=row=>row.collection==='$root'?quarantineRoot:quarantineRoot.collection(row.collection).doc(row.id);
  async function flushFinancial(){
   if(!pending.length)return;state.guard.remaining();handle.check();
   const rows=pending,qTargets=rows.map(qRef),liveTargets=rows.map(liveRef);
   const qSnaps=await state.guard.run(()=>db.getAll(...qTargets));
   for(const [i,qSnap]of qSnaps.entries()){
    if(!qSnap.exists||canonical(qSnap.data())!==canonical(quarantineTargetValue(rows[i],context)))fail('quarantine-tampered');
   }
   const nextFinancial={records,bytes:recordBytes,prefixSha256:digest.copy().digest('hex'),lastPath,counts:{...counts}};
   if(records<=prefixRecords){
    const liveSnaps=await state.guard.run(()=>db.getAll(...liveTargets));
    for(const [i,liveSnap]of liveSnaps.entries()){
     if(!liveSnap.exists||canonical(liveSnap.data())!==canonical(rows[i].payload))fail('live-target-tampered');
    }
    if(records===prefixRecords&&(nextFinancial.prefixSha256!==actState.financialPrefixSha256||nextFinancial.bytes!==actState.financialBytes||nextFinancial.lastPath!==actState.financialLastPath||canonical(nextFinancial.counts)!==canonical(actState.financialCounts)))fail('activation-prefix-integrity');
   }else{
    actState=await state.guard.run(()=>db.runTransaction(async tx=>{
     const cur=await currentAct(tx);
     if(cur.financialRecords!==actState.financialRecords||cur.financialPrefixSha256!==actState.financialPrefixSha256)fail('activation-journal-changed');
     const existing=await Promise.all(liveTargets.map(t=>tx.get(t)));
     if(existing.some(doc=>doc.exists))fail('live-target-collision');
     for(const [i,t]of liveTargets.entries())tx.create(t,rows[i].payload);
     const updated={...cur,financialRecords:nextFinancial.records,financialBytes:nextFinancial.bytes,financialPrefixSha256:nextFinancial.prefixSha256,financialLastPath:nextFinancial.lastPath,financialCounts:nextFinancial.counts,verifiedFinancialSha256:''};
     tx.set(actRef,updated);return updated;
    },{maxAttempts:1}));
    batches++;
    if(batches>=selected.batches)throw budgetBreak;
   }
   pending=[];pendingBytes=0;
  }
  let verifiedImage;
  try{
   verifiedImage=await verifyFirestoreRecoveryImage({...state.image,async onRecord(row){
    state.guard.remaining();const size=Buffer.byteLength(canonical(row.payload));if(size>1_048_576)fail('record-byte-limit');
    if(pending.length&&(pending.length===20||pendingBytes+size>1_048_576))await flushFinancial();
    records++;recordBytes+=Buffer.byteLength(canonical(row));counts[row.collection]++;lastPath=row.collection+'/'+row.id;digest.update(canonical(row)).update('\n');pending.push(row);pendingBytes+=size;
    if(records===prefixRecords)await flushFinancial();
   }});
   await flushFinancial();
  }catch(error){
   if(error!==budgetBreak)throw error;
   stoppedFinancial=true;
  }
  if(stoppedFinancial)return result('activating_financial',false,{objects:objectVerify,financial:{state:'activating',records:actState.financialRecords,batches}});
  if(actState.financialRecords!==verifiedImage.recordCount||actState.financialPrefixSha256!==verifiedImage.sourceProof.documentsSha256)fail('financial-progress-mismatch');

  async function verifyLiveTenant(proof){
   const foundCollections=await childCollections(liveRoot.path),expectedCollections=TENANT_RECOVERY_COLLECTIONS.filter(name=>proof.counts[name]>0);
   if(canonical(foundCollections)!==canonical(expectedCollections))fail('live-target-collections');
   const rootSnap=await state.guard.run(()=>liveRoot.get());if(!rootSnap.exists)fail('live-target-tampered');
   const qRootSnap=await state.guard.run(()=>quarantineRoot.get());
   if(!qRootSnap.exists||canonical(rootSnap.data())!==canonical(qRootSnap.data().sourceRoot)||rootSnap.data().enabled!==true)fail('live-target-tampered');
   const streamDigest=createHash('sha256'),liveCounts=blankCounts();let liveRecords=0,liveBytes=0;
   function acceptLive(collection,docId,payload,qData){
    const expectedRow={collection,id:docId,payload,source:qData?.sourceMetadata};
    if(!qData||canonical(qData)!==canonical(quarantineTargetValue(expectedRow,context)))fail('live-target-tampered');
    const raw=canonical(expectedRow);liveRecords++;liveBytes+=Buffer.byteLength(raw);liveCounts[collection]++;
    if(liveRecords>proof.records||liveBytes>proof.bytes)fail('live-target-limit');
    streamDigest.update(raw).update('\n');
   }
   acceptLive('$root',context.tenantId,rootSnap.data(),qRootSnap.data());
   for(const collection of expectedCollections){
    let pageToken='',last='',pages=0;
    do{
     if(++pages>proof.records+1)fail('inventory-page-limit');
     const page=await firestoreRest(liveRoot.path+'/'+collection,{query:{pageSize:'1',showMissing:'true',...(pageToken?{pageToken}:{})}});
     if(!Array.isArray(page.documents??[])||(page.documents??[]).length>1)fail('inventory-page');
     for(const doc of page.documents??[]){
      const prefix=`projects/${DEMO_PROJECT_ID}/databases/(default)/documents/${liveRoot.path}/${collection}/`;
      if(typeof doc.name!=='string'||!doc.name.startsWith(prefix)||!doc.updateTime||!doc.createTime)fail('live-orphan-or-path');
      const docId=doc.name.slice(prefix.length);id(docId);if(docId<=last)fail('inventory-order');last=docId;
      if((await childCollections(liveRoot.path+'/'+collection+'/'+docId)).length)fail('live-nested-target');
      const qDocSnap=await state.guard.run(()=>quarantineRoot.collection(collection).doc(docId).get());
      acceptLive(collection,docId,decodeRecoveryFields(doc.fields??{}),qDocSnap.data());
     }
     const next=page.nextPageToken??'';if(typeof next!=='string'||next.length>4096||next&&next===pageToken||next&&!(page.documents??[]).length)fail('inventory-token');pageToken=next;
    }while(pageToken);
   }
   if(liveRecords!==proof.records||liveBytes!==proof.bytes||canonical(liveCounts)!==canonical(proof.counts)||streamDigest.digest('hex')!==proof.documentsSha256)fail('live-target-reconciliation');
  }
  await verifyLiveTenant(verifiedImage.sourceProof);
  actState=await state.guard.run(()=>db.runTransaction(async tx=>{
   const cur=await currentAct(tx),updated={...cur,verifiedFinancialSha256:verifiedImage.sourceProof.documentsSha256};tx.set(actRef,updated);return updated;
  },{maxAttempts:1}));
  await checkpoint('activating_financial');await notify('activating_financial');

  // Layer 3: Promote quarantined operator history and activate quarantined Auth accounts.
  const authQSnap=await state.guard.run(()=>authorityQuarantineRoot.get());
  if(!authQSnap.exists||authQSnap.data()?.state!=='verified_quarantine'||authQSnap.data()?.packageSha256!==plan.authorityPackageSha256)fail('authority-quarantine-tampered');
  let operatorsDone=0,newOperators=0,usersDone=0,newUsers=0;
  for(const row of authorityPayload.operatorRecords){
   state.guard.remaining();handle.check();
   const opHash=authorityDigest(row.path),qOpRef=authorityQuarantineRoot.collection('operatorRecords').doc(opHash),actOpRef=actRef.collection('operatorRecords').doc(opHash),liveOpRef=db.doc(row.path);
   const expectedQuarantineOp={format:'disabled-operator-history-v1',enabled:false,activationAllowed:false,sourcePath:row.path,sourceProjectId:context.projectId,sourceTenantId:context.tenantId,packageSha256:plan.authorityPackageSha256,sourceSha256:authorityDigest(row),payload:row.payload};
   const expectedActOp={format:'activated-operator-record-v1',path:row.path,sourceSha256:authorityDigest(row),coordinatorPlanSha256:plan.coordinatorPlanSha256};
   const created=await state.guard.run(()=>db.runTransaction(async tx=>{
    await currentAct(tx);
    const [qSnap,actOpSnap,liveOpSnap]=await Promise.all([tx.get(qOpRef),tx.get(actOpRef),tx.get(liveOpRef)]);
    if(!qSnap.exists||canonical(qSnap.data())!==canonical(expectedQuarantineOp))fail('authority-quarantine-tampered');
    if(actOpSnap.exists){
     if(canonical(actOpSnap.data())!==canonical(expectedActOp)||!liveOpSnap.exists||canonical(liveOpSnap.data())!==canonical(row.payload))fail('live-operator-tampered');
     return false;
    }
    if(liveOpSnap.exists)fail('live-operator-collision');
    tx.create(liveOpRef,row.payload);tx.create(actOpRef,expectedActOp);return true;
   },{maxAttempts:1}));
   operatorsDone++;if(created)newOperators++;
   if(newOperators>=selected.operatorRecords&&(operatorsDone<authorityPayload.operatorRecords.length||authorityPayload.users.length>0)){
    return result('activating_authority',false,{objects:objectVerify,financial:{state:'activated',records:actState.financialRecords},authority:{state:'activating',operatorRecords:operatorsDone,users:0}});
   }
  }

  for(const u of authorityPayload.users){
   state.guard.remaining();handle.check();
   const uDigest=authorityDigest(u),qUserRef=authorityQuarantineRoot.collection('authUsers').doc(u.localId),actUserRef=actRef.collection('authUsers').doc(u.localId),memberRef=liveRoot.collection('members').doc(u.localId);
   const [qUserSnap,actUserSnap,memberSnap]=await state.guard.run(()=>db.getAll(qUserRef,actUserRef,memberRef));
   if(!qUserSnap.exists||qUserSnap.data()?.state!=='verified'||qUserSnap.data()?.sourceSha256!==uDigest||qUserSnap.data()?.packageSha256!==plan.authorityPackageSha256)fail('authority-quarantine-tampered');
   if(!memberSnap.exists||memberSnap.data()?.uid!==u.localId)fail('member-record-missing');
   const found=await authLookup({localId:[u.localId]}),byEmail=await authLookup({email:[u.email]});
   if(!found||byEmail?.uid!==u.localId)fail('auth-user-missing');
   const actUser=actUserSnap.exists?actUserSnap.data():null;
   if(actUser){
    exact(actUser,['format','uid','sourceSha256','coordinatorPlanSha256','state']);
    if(actUser.format!=='activated-auth-user-v1'||actUser.uid!==u.localId||actUser.sourceSha256!==uDigest||actUser.coordinatorPlanSha256!==plan.coordinatorPlanSha256||!['activating','activated'].includes(actUser.state))fail('auth-activation-journal-tampered');
   }
   const wasActivated=actUser?.state==='activated';
   if(wasActivated){
    if(!isActivatedUser(found,u))fail('auth-tampered');
   }else{
    if(!actUser){
     if(!isQuarantinedUser(found,u))fail('auth-tampered');
     await state.guard.run(()=>db.runTransaction(async tx=>{
      await currentAct(tx);const old=await tx.get(actUserRef);if(old.exists)fail('auth-activation-journal-changed');
      tx.create(actUserRef,{format:'activated-auth-user-v1',uid:u.localId,sourceSha256:uDigest,coordinatorPlanSha256:plan.coordinatorPlanSha256,state:'activating'});
     },{maxAttempts:1}));
    }else if(!isQuarantinedUser(found,u)&&!isActivatedUser(found,u)){
     fail('auth-tampered');
    }
    if(!isActivatedUser(found,u)){
     await fenceAct();uncertainAuthWrite=true;
     try{await authActivateUser(u,authorityPayload.hash);uncertainAuthWrite=false;}
     catch(error){if(error.definitiveAuthRejection)uncertainAuthWrite=false;fail('auth-activate-ambiguous');}
    }
    await fenceAct();
    const afterUser=await authLookup({localId:[u.localId]});
    if(!isActivatedUser(afterUser,u))fail('auth-activation-verification');
    await state.guard.run(()=>db.runTransaction(async tx=>{
     await currentAct(tx);const old=await tx.get(actUserRef);if(!old.exists)fail('auth-activation-journal-changed');
     tx.update(actUserRef,{state:'activated'});
    },{maxAttempts:1}));
   }
   usersDone++;if(!wasActivated)newUsers++;
   if(newUsers>=selected.users&&usersDone<authorityPayload.users.length){
    return result('activating_authority',false,{objects:objectVerify,financial:{state:'activated',records:actState.financialRecords},authority:{state:'activating',operatorRecords:operatorsDone,users:usersDone}});
   }
  }
  await checkpoint('activating_authority');await notify('activating_authority');

  // Layer 4: Full final verification across all quarantine and live layers.
  await checkpoint('activating_verifying');
  const objectFinal=await verifyRecoveryObjectDestination({plan:state.objectPlan,destinationStorage:destinationIO,limits:{runtimeMs:state.guard.remaining(),requestMs:state.selected.requestMs}});
  if(objectFinal.byteIntegrityVerified!==true)fail('object-verification');
  await verifyDestinationArchiveAndSnapshotObjects({state,destinationIO});
  const financialQuarantineFinal=await restoreFirestoreRecoveryQuarantine({db,environment:handle.environment,...state.image,maxRuntimeMs:state.guard.remaining()});
  verified(financialQuarantineFinal);
  await verifyLiveTenant(verifiedImage.sourceProof);
  for(const row of authorityPayload.operatorRecords){
   const liveOpSnap=await state.guard.run(()=>db.doc(row.path).get());
   if(!liveOpSnap.exists||canonical(liveOpSnap.data())!==canonical(row.payload))fail('live-operator-tampered');
  }
  for(const u of authorityPayload.users){
   const found=await authLookup({localId:[u.localId]}),byEmail=await authLookup({email:[u.email]});
   if(!isActivatedUser(found,u)||byEmail?.uid!==u.localId)fail('auth-activation-verification');
  }
  const actChildren=await childCollections(actRef.path),expectedActChildren=['authUsers',...(authorityPayload.operatorRecords.length?['operatorRecords']:[])].sort();
  if(canonical(actChildren)!==canonical(expectedActChildren))fail('activation-inventory');
  await state.guard.run(()=>db.runTransaction(async tx=>{
   const cur=await currentAct(tx);
   tx.set(actRef,{...cur,state:'activated_demo_recovery',owner:'',leaseUntilMs:0});
  },{maxAttempts:1}));
  leaseAcquired=false;
  await checkpoint('activated_demo_recovery');
  return result('complete',true,{
   objects:objectFinal,
   financial:{state:'activated_demo_recovery',records:verifiedImage.recordCount,documentsSha256:verifiedImage.sourceProof.documentsSha256,quarantineState:financialQuarantineFinal.state},
   authority:{state:'activated_demo_recovery',users:authorityPayload.users.length,operatorRecords:authorityPayload.operatorRecords.length,customClaimsActivated:true,accountsEnabled:true},
   allLayerTargetsVerified:true,
  });
 }finally{
  try{
   if(leaseAcquired&&!uncertainAuthWrite){
    const actRef=handle.db.doc('recoveryCoordinatorActivations/'+plan.context.imageId);
    await handle.db.runTransaction(async tx=>{const s=await tx.get(actRef),j=s.data();if(j?.owner===owner)tx.update(actRef,{owner:'',leaseUntilMs:0});},{maxAttempts:1}).catch(()=>{});
   }
  }finally{
   try{await journal?.close();}finally{state.active=false;busy.delete(target);disposeRecoveryCoordinator(plan);}
  }
 }
}

export async function activateRecoveryCoordinatorDemo({target,image,authorityEnvelope,authorityMasterKey,objects,destinationDirectory,journalDirectory,limits,budgets,afterPhase}){
 if(!targets.has(target))fail('owned-target');const plan=await prepareRecoveryCoordinator({image,authorityEnvelope,authorityMasterKey,objects,limits});
 try{return await activatePreparedRecoveryCoordinator({target,plan,destinationDirectory,journalDirectory,budgets,afterPhase});}finally{if(plans.has(plan))disposeRecoveryCoordinator(plan);}
}
