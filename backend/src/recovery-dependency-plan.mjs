// A dependency inventory, not authority to restore credentials or activate data.
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {freezeRecoveryValue,isFirestoreRecoveryProof} from './firestore-recovery-source.mjs';
const hex=/^[a-f0-9]{64}$/,sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
const limits=Object.freeze({users:10_000,objects:40_000,keys:256,serverPrincipals:10_000,bytes:8_388_608});
export const RECOVERY_SERVER_AUDIT_POLICY_VERSION=1;
const requirements=new WeakSet();
const authorityPolicy='Do not import cached sessions, device authority or license packages as active authority. Re-enroll and verify using separately approved operator procedures.';
const activationGates=['provider-backup-consistency-and-independent-restore-acceptance-required','fresh-auth-device-and-license-enrollment-required','production-activation-not-implemented'];
function fail(reason){throw Error('recovery-dependency-'+reason);}
function object(value){if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('schema');}
function artifact(value){object(value);if(typeof value.key!=='string'||!value.key||value.key.length>1024||/[\x00-\x1f]/.test(value.key)||!hex.test(value.sha256))fail('artifact');return {key:value.key,sha256:value.sha256};}
function context(value,proof){if(value.projectId!==proof.projectId||value.databaseId!==proof.databaseId||value.tenantId!==proof.tenantId||value.readTime!==proof.readTime)fail('context');}
function bounded(value){if(Buffer.byteLength(canonical(value))>limits.bytes)fail('byte-limit');return value;}

// These labels are produced by trusted server operators, not Firebase Auth.
// Classification is per exact audit record, never a global UID exemption.
function serverAuditPrincipal(row){
 if(row.collection!=='audit'||!row.payload||Object.getPrototypeOf(row.payload)!==Object.prototype)return null;
 const p=row.payload,fields=Object.keys(p).sort().join('|');
 const shape=names=>fields===[...names].sort().join('|');
 const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
 const time=Number.isSafeInteger(p.atMs)&&p.atMs>=0&&p.atMs<=8_640_000_000_000_000;
 if(!time)return null;
 let kind=null;
 if(row.id==='tenant_created'&&p.action==='tenant-created'&&p.actorUid==='trusted-operator'&&
   shape(['action','actorUid','ownerUid','atMs'])&&safeId(p.ownerUid))kind='trusted-tenant-enrollment';
 const device=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
 if(p.action==='trusted-device-transfer'&&p.actorUid==='trusted-operator'&&
   shape(['action','actorUid','uid','oldDeviceId','newDeviceId','atMs'])&&safeId(p.uid)&&device(p.newDeviceId)&&
   row.id==='transfer_'+p.newDeviceId&&(p.oldDeviceId===null||device(p.oldDeviceId)&&p.oldDeviceId!==p.newDeviceId))kind='trusted-demo-device-transfer';
 const ownerActions=['create-tenant','add-manager','set-tenant-enabled','set-member-active','activate-license'];
 if(p.actorUid==='local-owner-admin'&&ownerActions.includes(p.action)&&shape(['action','actorUid','atMs','operationId'])&&
   typeof p.operationId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.operationId)&&row.id==='admin_'+p.operationId)kind='local-owner-administration';
 return kind?{collection:'audit',id:row.id,actorUid:p.actorUid,kind,sourceRecordSha256:sha(row)}:null;
}

// Called on exactly the rows delivered by source.capture; finish compares their
// stream hash to the branded source proof, so an omitted authority row cannot
// produce an apparently complete dependency inventory.
function dependencyCollector(branded,{serverAuditPolicy=false}={}){
 const users=new Set(),keys=new Set(),objects=new Map(),serverPrincipals=new Map(),digest=createHash('sha256');let count=0,closed=false;
 function addUser(value){if(value===null||value===undefined||value==='')return;if(typeof value!=='string')fail('user-schema');id(value);users.add(value);if(users.size>limits.users)fail('user-limit');}
 function addKey(value){if(value===null||value===undefined||value==='')return;if(typeof value!=='string')fail('key-schema');id(value);keys.add(value);if(keys.size>limits.keys)fail('key-limit');}
 function addObject(value){const ref=artifact(value),previous=objects.get(ref.key);if(previous&&previous.sha256!==ref.sha256)fail('object-hash-conflict');objects.set(ref.key,ref);if(objects.size>limits.objects)fail('object-limit');}
 function visit(value,depth=0,skipActor=false){
  if(depth>20)fail('depth');if(!value||typeof value!=='object')return;
  if(!Array.isArray(value)){
   if(typeof value.key==='string'&&(value.sha256!==undefined||value.cipherSha256!==undefined))addObject({key:value.key,sha256:value.cipherSha256??value.sha256});
   if(value.manifestKey!==undefined||value.manifestSha256!==undefined){if(value.manifestKey===undefined||value.manifestSha256===undefined)fail('incomplete-object-reference');addObject({key:value.manifestKey,sha256:value.manifestSha256});}
   for(const [name,child]of Object.entries(value)){
    if((name==='uid'||/Uid$/.test(name))&&!(skipActor&&depth===0&&name==='actorUid'))addUser(child);
    if(name==='keyId'||name==='kid')addKey(child);
    if(name==='keyIds'){if(!Array.isArray(child))fail('keys-schema');for(const key of child)addKey(key);}
   }
  }
  for(const child of Object.values(value))visit(child,depth+1);
 }
 return Object.freeze({
  observe(row){if(closed)fail('collector-closed');if(row.collection==='members')addUser(row.id);
   const principal=serverAuditPolicy?serverAuditPrincipal(row):null;
   if(principal){if(serverPrincipals.has(row.id))fail('server-principal-duplicate');serverPrincipals.set(row.id,principal);if(serverPrincipals.size>limits.serverPrincipals)fail('server-principal-limit');}
   visit(row.payload,0,principal!==null);digest.update(canonical(row)).update('\n');count++;},
  finish({sourceProof,imageKeyId}){
   if(closed||branded&&!isFirestoreRecoveryProof(sourceProof))fail('source-proof');closed=true;addKey(imageKeyId);
   if(count!==sourceProof.records||digest.digest('hex')!==sourceProof.documentsSha256)fail('source-stream-mismatch');
   const value=freezeRecoveryValue(bounded({format:'strawberry-recovery-dependencies',version:1,
    source:{projectId:sourceProof.projectId,databaseId:sourceProof.databaseId,tenantId:sourceProof.tenantId,readTime:sourceProof.readTime,documentsSha256:sourceProof.documentsSha256},
    authUids:[...users].sort(),objectRoots:[...objects.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),keyIds:[...keys].sort(),
    ...(serverPrincipals.size?{serverAuditPrincipalPolicyVersion:RECOVERY_SERVER_AUDIT_POLICY_VERSION,
     serverAuditPrincipals:[...serverPrincipals.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}:{})}));if(branded)requirements.add(value);return value;
  },
 });
}
export function createRecoveryDependencyCollector(){return dependencyCollector(true,{serverAuditPolicy:true});}

// Used only after the image reader authenticates its manifest. Recompute the
// dependency requirements from every decrypted row; this does not brand the
// parsed proof or make it usable as a new trusted capture source.
export function createRecoveryDependencyVerifier(plan){
 object(plan);bounded(plan);
 const keys=['format','version','source','requirementsSha256','required','supplied','missing','inventoryComplete','evidenceStatus','activationAllowed','activationBlockers','authorityPolicy'];
 if(Object.keys(plan).sort().join('|')!==keys.sort().join('|')||plan.format!=='strawberry-recovery-dependency-plan'||plan.version!==1||plan.activationAllowed!==false||plan.evidenceStatus!=='supplied-inventory-not-provider-acceptance'||plan.authorityPolicy!==authorityPolicy)fail('plan-schema');
 if(!Array.isArray(plan.missing)||plan.missing.some(v=>typeof v!=='string'||!v)||canonical([...new Set(plan.missing)].sort())!==canonical(plan.missing)||plan.inventoryComplete!==(plan.missing.length===0)||canonical(plan.activationBlockers)!==canonical([...plan.missing,...activationGates]))fail('plan-gates');
 object(plan.supplied);
 const shapes={authExport:['key','sha256','uidInventorySha256'],operatorHistory:['key','sha256'],snapshotCatalog:['key','sha256','rootInventorySha256'],objectClosure:['key','sha256','objectInventorySha256','requiredKeyIds'],keyCustody:['key','sha256','keyInventorySha256']};
 for(const [name,item]of Object.entries(plan.supplied)){
  if(!Object.hasOwn(shapes,name))fail('supplied-schema');object(item);artifact(item);
  if(Object.keys(item).sort().join('|')!==[...shapes[name]].sort().join('|'))fail('supplied-schema');
  for(const [key,value]of Object.entries(item))if(key.endsWith('Sha256')&&!hex.test(value))fail('supplied-hash');
  if(name==='objectClosure'){if(!Array.isArray(item.requiredKeyIds)||item.requiredKeyIds.length>limits.keys)fail('key-limit');for(const value of item.requiredKeyIds)id(value);}
 }
 if(plan.inventoryComplete&&Object.keys(plan.supplied).length!==Object.keys(shapes).length)fail('plan-incomplete');
 object(plan.required);const hasPolicy=Object.hasOwn(plan.required,'serverAuditPrincipalPolicyVersion');
 if(hasPolicy!==Object.hasOwn(plan.required,'serverAuditPrincipals')||hasPolicy&&(plan.required.serverAuditPrincipalPolicyVersion!==RECOVERY_SERVER_AUDIT_POLICY_VERSION||!Array.isArray(plan.required.serverAuditPrincipals)||!plan.required.serverAuditPrincipals.length||plan.required.serverAuditPrincipals.length>limits.serverPrincipals))fail('server-principal-policy');
 // Absent policy retains the old all-UID interpretation for already captured
 // images. A new policy is always re-derived from actual decrypted records.
 const collector=dependencyCollector(false,{serverAuditPolicy:hasPolicy});
 return Object.freeze({observe:row=>collector.observe(row),finish(options){
  const required=collector.finish(options);
  if(plan.requirementsSha256!==sha(required)||canonical(plan.required)!==canonical(required)||canonical(plan.source)!==canonical(required.source))fail('plan-stream-mismatch');
  return required;
 }});
}

// Evidence is an exact inventory of separately captured artifacts. It is never
// treated as proof of provider durability or authority to reuse Auth credentials.
// Callers must retain the referenced artifacts and independently restore-test
// them; this function deliberately performs no I/O and cannot activate a tenant.
export function buildRecoveryDependencyPlan({required,evidence={}}){
 if(!requirements.has(required))fail('captured-requirements-required');object(evidence);bounded(evidence);
 const blockers=[],supplied={},source=required.source;
 function packageEvidence(name){const item=evidence[name];if(!item){blockers.push(name+'-missing');return null;}object(item);context(item,source);artifact(item);supplied[name]={...artifact(item)};return item;}
 const auth=packageEvidence('authExport');
 if(auth){if(!Array.isArray(auth.uids)||auth.uids.length>limits.users||new Set(auth.uids).size!==auth.uids.length)fail('auth-users');for(const uid of auth.uids)id(uid);const present=new Set(auth.uids);if(required.authUids.some(uid=>!present.has(uid)))blockers.push('auth-users-missing');supplied.authExport.uidInventorySha256=sha([...present].sort());}
 // Operator history includes issuance, transfer/revocation and top-level audit
 // collections, which are outside the tenant root and are not invented here.
 packageEvidence('operatorHistory');
 const catalog=packageEvidence('snapshotCatalog');
 let snapshotRoots=[];
 if(catalog){if(!Array.isArray(catalog.objectRoots)||catalog.objectRoots.length>limits.objects)fail('snapshot-roots');snapshotRoots=catalog.objectRoots.map(artifact);supplied.snapshotCatalog.rootInventorySha256=sha(snapshotRoots);}
 const closure=packageEvidence('objectClosure');
 if(closure){
  if(!Array.isArray(closure.objects)||closure.objects.length>limits.objects)fail('object-limit');const inventory=new Map();
  for(const obj of closure.objects){const ref=artifact(obj);if(inventory.has(ref.key))fail('duplicate-object');if(!Array.isArray(obj.children)||obj.children.length>limits.objects)fail('object-children');const children=obj.children.map(artifact);const keyIds=obj.keyIds??[];if(!Array.isArray(keyIds)||keyIds.length>limits.keys)fail('key-limit');for(const key of keyIds)id(key);inventory.set(ref.key,{...ref,children,keyIds});}
  const needed=[...required.objectRoots,...snapshotRoots],seen=new Set(),extraKeys=new Set();
  for(let index=0;index<needed.length;index++){
   if(needed.length>limits.objects)fail('object-limit');const ref=needed[index],item=inventory.get(ref.key);
   if(!item||item.sha256!==ref.sha256){blockers.push('object-missing-or-hash-mismatch:'+ref.key);continue;}
   if(seen.has(ref.key))continue;seen.add(ref.key);needed.push(...item.children);for(const key of item.keyIds)extraKeys.add(key);
  }
  supplied.objectClosure.objectInventorySha256=sha([...inventory.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0));
  supplied.objectClosure.requiredKeyIds=[...new Set([...required.keyIds,...extraKeys])].sort();
 }
 const keyPackage=packageEvidence('keyCustody');
 const neededKeys=supplied.objectClosure?.requiredKeyIds??required.keyIds;
 if(keyPackage){if(!Array.isArray(keyPackage.keyIds)||keyPackage.keyIds.length>limits.keys)fail('key-limit');for(const key of keyPackage.keyIds)id(key);if(neededKeys.some(key=>!keyPackage.keyIds.includes(key)))blockers.push('key-ids-missing');supplied.keyCustody.keyInventorySha256=sha([...new Set(keyPackage.keyIds)].sort());}
 const missing=Array.from(new Set(blockers)).sort();
 return freezeRecoveryValue(bounded({format:'strawberry-recovery-dependency-plan',version:1,source,requirementsSha256:sha(required),required,
  supplied,missing,inventoryComplete:missing.length===0,evidenceStatus:'supplied-inventory-not-provider-acceptance',activationAllowed:false,
  activationBlockers:[...missing,...activationGates],authorityPolicy}));
}
