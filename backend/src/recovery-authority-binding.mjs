// Inert cross-component binding. Verifies the complete financial image before
// any separately guarded, disabled demo Auth import. Never grants activation.
import {canonical,integer} from './validation.mjs';
import {verifyFirestoreRecoveryImage} from './firestore-recovery-image.mjs';
import {freezeRecoveryValue} from './firestore-recovery-source.mjs';
import {AUTHORITY_RECOVERY_LIMITS,authorityDigest,openRecoveryAuthorityPackage} from './recovery-authority-package.mjs';
import {restoreRecoveryAuthorityDemo} from './recovery-authority-demo.mjs';

export const AUTHORITY_BINDING_LIMITS=Object.freeze({
 envelopeBytes:AUTHORITY_RECOVERY_LIMITS.envelopeBytes,imageReadBytes:8_388_608,
 totalImageReadBytes:1_073_741_824,imageReads:30_000,runtimeMs:1_800_000,requestMs:10_000,
});
const prepared=new WeakMap(),hex=/^[a-f0-9]{64}$/;
function fail(reason){throw Error('recovery-authority-binding-'+reason);}
function object(value){if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('schema');}
function exact(value,names){object(value);if(Object.keys(value).sort().join('|')!==[...names].sort().join('|'))fail('schema');for(const key of names){if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))fail('data-properties-required');}}
function limitsFor(value={}){object(value);if(Object.keys(value).some(key=>!Object.hasOwn(AUTHORITY_BINDING_LIMITS,key)))fail('limit-option');const result={...AUTHORITY_BINDING_LIMITS,...value};for(const [key,max]of Object.entries(AUTHORITY_BINDING_LIMITS))integer(result[key],1,max);return Object.freeze(result);}
function bytes(value,max,exactSize=null){if(!(value instanceof Uint8Array)||value.byteLength<1||value.byteLength>max||exactSize!==null&&value.byteLength!==exactSize||typeof SharedArrayBuffer!=='undefined'&&value.buffer instanceof SharedArrayBuffer)fail('byte-input');return Buffer.from(value);}
function budget(limits,monotonicNow){if(typeof monotonicNow!=='function')fail('clock');let previous=monotonicNow();if(!Number.isFinite(previous)||previous<0)fail('clock');const start=previous;let requests=0,totalBytes=0;
 function remaining(){const now=monotonicNow();if(!Number.isFinite(now)||now<previous)fail('clock');previous=now;const left=limits.runtimeMs-(now-start);if(left<1)fail('deadline');return left;}
 async function read(readFn,key,{maxBytes}){remaining();integer(maxBytes,1,limits.imageReadBytes);if(++requests>limits.imageReads)fail('read-limit');if(totalBytes+maxBytes>limits.totalImageReadBytes)fail('read-byte-limit');const controller=new AbortController();let timer;try{const result=await Promise.race([Promise.resolve().then(()=>readFn(key,{maxBytes,signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('recovery-authority-binding-deadline'));},Math.max(1,Math.floor(Math.min(limits.requestMs,remaining()))));})]);remaining();const owned=bytes(result,maxBytes);totalBytes+=owned.length;if(totalBytes>limits.totalImageReadBytes)fail('read-byte-limit');return owned;}finally{clearTimeout(timer);controller.abort();}}
 return {remaining,read,statistics:()=>({imageReads:requests,imageReadBytes:totalBytes})};
}
function sourceContext(image){exact(image.expected,['projectId','databaseId','tenantId','readTime','imageId','keyId']);const expected={};for(const [key,value]of Object.entries(image.expected)){if(typeof value!=='string'||!value||value.length>256)fail('context');expected[key]=value;}if(typeof image.manifestKey!=='string'||image.manifestKey.length>1024||!hex.test(image.manifestSha256))fail('image-reference');return freezeRecoveryValue(expected);}

export async function prepareImageBoundRecoveryAuthority({image,authorityEnvelope,authorityMasterKey,limits={},monotonicNow=()=>performance.now()}){
 exact(image,['storage','manifestKey','manifestSha256','masterKey','expected']);const selected=limitsFor(limits),guard=budget(selected,monotonicNow),expected=sourceContext(image);
 if(typeof image.storage?.read!=='function')fail('image-storage');const read=image.storage.read.bind(image.storage),manifestKey=image.manifestKey,manifestSha256=image.manifestSha256;
 // Copy all caller-owned bytes/context before the first asynchronous read. A
 // SharedArrayBuffer is refused; no caller receives these private copies.
 let imageKey,envelope,authorityKey,retained=false;
 try{
  imageKey=bytes(image.masterKey,32,32);envelope=bytes(authorityEnvelope,selected.envelopeBytes);authorityKey=bytes(authorityMasterKey,32,32);
  const verified=await verifyFirestoreRecoveryImage({storage:{read:(key,options)=>guard.read(read,key,options)},manifestKey,manifestSha256,masterKey:imageKey,expected});guard.remaining();
  const context=freezeRecoveryValue({...expected,imageManifestSha256:manifestSha256});
  const authority=openRecoveryAuthorityPackage({envelope,masterKey:authorityKey,expected:context});guard.remaining();
  const plan=verified.dependencyPlan,auth=plan.supplied.authExport,operators=plan.supplied.operatorHistory;
  if(!auth||!operators)fail('original-authority-artifacts-required');
  if(authority.sourceAuthSha256!==auth.sha256)fail('source-auth-artifact');
  if(authority.sourceOperatorSha256!==operators.sha256)fail('source-operator-artifact');
  const required=plan.required.authUids;
  // Exact inventory prevents a tenant-specific restore from also importing
  // unrelated source-project accounts. Broader exports must be scoped first.
  if(canonical(authority.uidInventory)!==canonical(required))fail('required-uid-inventory');
  const uidInventorySha256=authorityDigest(authority.uidInventory);
  if(uidInventorySha256!==auth.uidInventorySha256)fail('supplied-uid-inventory');
  const value=freezeRecoveryValue({format:'strawberry-image-bound-authority',version:1,context,
   imageManifestSha256:manifestSha256,authorityPackageSha256:authorityDigest(envelope),
   sourceAuthSha256:authority.sourceAuthSha256,sourceOperatorSha256:authority.sourceOperatorSha256,
   uidInventorySha256,users:authority.users.length,operatorRecords:authority.operatorRecords.length,
   fullImageVerified:true,exactRequiredUidInventoryVerified:true,originalArtifactHashesVerified:true,
   activationAllowed:false,productionRecoveryAccepted:false,...guard.statistics()});
  prepared.set(value,{envelope,authorityKey,context,guard,used:false});retained=true;return value;
 }finally{imageKey?.fill(0);if(!retained){envelope?.fill(0);authorityKey?.fill(0);}}
}

export function disposeImageBoundRecoveryAuthority(plan){const state=prepared.get(plan);if(!state)return false;if(state.used)fail('prepared-plan-busy');state.envelope.fill(0);state.authorityKey.fill(0);prepared.delete(plan);return true;}

export async function restorePreparedImageBoundAuthority({target,plan,restoreOptions={}}){
 const state=prepared.get(plan);if(!state||state.used)fail('prepared-plan-required');object(restoreOptions);
 const allowed=['maxUsers','maxOperatorRecords','maxRuntimeMs','afterReservation','afterImport','afterUserCommit'];
 if(Object.keys(restoreOptions).some(key=>!allowed.includes(key)))fail('restore-option');
 const remaining=Math.floor(state.guard.remaining());
 if(restoreOptions.maxRuntimeMs!==undefined)integer(restoreOptions.maxRuntimeMs,1,AUTHORITY_BINDING_LIMITS.runtimeMs);
 const maxRuntimeMs=Math.min(restoreOptions.maxRuntimeMs??remaining,remaining);state.used=true;
 try{
  const result=await restoreRecoveryAuthorityDemo({...restoreOptions,target,envelope:state.envelope,masterKey:state.authorityKey,expected:state.context,maxRuntimeMs});state.guard.remaining();
  if(result.activationAllowed!==false||result.productionRecoveryAccepted!==false)fail('activation');
  return freezeRecoveryValue({...result,imageManifestSha256:plan.imageManifestSha256,
   authorityPackageSha256:plan.authorityPackageSha256,uidInventorySha256:plan.uidInventorySha256,
   fullImageVerified:true,originalArtifactHashesVerified:true,exactRequiredUidInventoryVerified:true,
   activationAllowed:false,productionRecoveryAccepted:false});
 }finally{state.envelope.fill(0);state.authorityKey.fill(0);prepared.delete(plan);}
}

export async function restoreImageBoundAuthority({target,image,authorityEnvelope,authorityMasterKey,limits,monotonicNow,restoreOptions}){
 const plan=await prepareImageBoundRecoveryAuthority({image,authorityEnvelope,authorityMasterKey,limits,monotonicNow});
 try{return await restorePreparedImageBoundAuthority({target,plan,restoreOptions});}
 finally{if(prepared.has(plan))disposeImageBoundRecoveryAuthority(plan);}
}
