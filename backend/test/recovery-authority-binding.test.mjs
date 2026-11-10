import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';
import {canonical} from '../src/validation.mjs';
import {createFirestoreRecoverySource} from '../src/firestore-recovery-source.mjs';
import {exportFirestoreRecoveryImage} from '../src/firestore-recovery-image.mjs';
import {captureRecoveryAuthorityPackage,authorityDigest} from '../src/recovery-authority-package.mjs';
import {AUTHORITY_BINDING_LIMITS,prepareImageBoundRecoveryAuthority,disposeImageBoundRecoveryAuthority,
 restorePreparedImageBoundAuthority,restoreImageBoundAuthority} from '../src/recovery-authority-binding.mjs';

const sourceContext={projectId:'demo-authority-binding',databaseId:'(default)',tenantId:'binding_business',readTime:'2026-11-07T05:00:00.000000Z'};
const now=Date.parse(sourceContext.readTime)+1000,old='2026-11-07T04:59:00Z';
const root=`projects/${sourceContext.projectId}/databases/(default)/documents/tenants/${sourceContext.tenantId}`;
const json=value=>Buffer.from(JSON.stringify(value));
function typed(value){if(value===null)return {nullValue:null};if(typeof value==='string')return {stringValue:value};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number')return {integerValue:String(value)};if(Array.isArray(value))return {arrayValue:{values:value.map(typed)}};return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([key,child])=>[key,typed(child)]))}};}
function document(path,payload){return {name:path,createTime:old,updateTime:old,fields:Object.fromEntries(Object.entries(payload).map(([key,child])=>[key,typed(child)]))};}
async function fixture(t,{uids=['employee_binding','manager_binding'],sourceUids=uids,authInventory=uids,authSha,operatorSha,dependencies=true,authorityContext={}}={}){
 const users=uids.map((uid,index)=>({localId:uid,email:'u'+index+'@binding.example.invalid',emailVerified:true,passwordHash:randomBytes(64).toString('base64'),salt:randomBytes(16).toString('base64'),disabled:false}));
 const operators=[{path:'adminOperations/binding_operation',payload:{tenantId:sourceContext.tenantId,type:'activate-license',trialStartMs:10,trialEndMs:1000}}];
 const authExportJson=json({users}),operatorRecordsJson=json(operators),masterKey=randomBytes(32),authorityMasterKey=randomBytes(32),hash={algorithm:'SCRYPT',key:randomBytes(64).toString('base64'),saltSeparator:'AQ==',rounds:8,memoryCost:14};
 const rows={[root]:document(root,{ownerUid:sourceUids.at(-1),enabled:true,sequence:3})};
 for(const uid of sourceUids)rows[root+'/members/'+uid]=document(root+'/members/'+uid,{uid,role:uid.startsWith('manager')?'manager':'employee',active:true,epoch:1});
 const server=createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;const url=new URL(req.url,'http://127.0.0.1'),path=decodeURIComponent(url.pathname.slice(4)),body=input?JSON.parse(input):null;let value;
  if(path.endsWith(':listCollectionIds')){const parent=path.slice(0,-18),collectionIds=[...new Set(Object.keys(rows).filter(key=>key.startsWith(parent+'/')).map(key=>key.slice(parent.length+1).split('/')).filter(parts=>parts.length>=2).map(parts=>parts[0]))].sort();value={collectionIds};}
  else if(rows[path])value=rows[path];else{const documents=Object.keys(rows).filter(key=>key.startsWith(path+'/')&&key.slice(path.length+1).split('/').length===1).sort().map(key=>rows[key]),offset=Number(url.searchParams.get('pageToken')??0),size=Number(url.searchParams.get('pageSize'));value={documents:documents.slice(offset,offset+size),...(offset+size<documents.length?{nextPageToken:String(offset+size)}:{})};}
  assert.equal(body?.readTime??url.searchParams.get('readTime'),sourceContext.readTime);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const source=createFirestoreRecoverySource({...sourceContext,endpoint:'http://127.0.0.1:'+server.address().port,allowLoopbackForTests:true,accessToken:async()=>'synthetic-binding-only',now:()=>now});
 const objects=new Map(),storage={async putImmutable(key,value){const bytes=Buffer.from(value),prior=objects.get(key);if(prior&&!prior.equals(bytes))throw Error('immutable-conflict');objects.set(key,bytes);},async read(key,{maxBytes}){const value=objects.get(key);if(!value)throw Error('missing-image-object');if(value.length>maxBytes)throw Error('bounded-image-object');return Buffer.from(value);}};
 const common={...sourceContext},dependencyEvidence=dependencies?{
  authExport:{...common,key:'supplied/original-auth.json',sha256:authSha??authorityDigest(authExportJson),uids:authInventory},
  operatorHistory:{...common,key:'supplied/original-operator.json',sha256:operatorSha??authorityDigest(operatorRecordsJson)},
 }:{};
 const imageId='binding_image',keyId='original_recovery_key',capture=await exportFirestoreRecoveryImage({source,storage,masterKey,imageId,keyId,createdAtMs:now,dependencyEvidence});
 const expected={...sourceContext,imageId,keyId},context={...expected,imageManifestSha256:capture.manifestSha256,...authorityContext};
 const authorityEnvelope=captureRecoveryAuthorityPackage({authExportJson,operatorRecordsJson,hash,context,requiredUids:uids,masterKey:authorityMasterKey});
 const image={storage,manifestKey:capture.manifestKey,manifestSha256:capture.manifestSha256,masterKey,expected};
 const options={image,authorityEnvelope,authorityMasterKey};
 return {options,objects,storage,context,authExportJson,operatorRecordsJson,users,capture,prepare:extra=>prepareImageBoundRecoveryAuthority({...options,...extra})};
}

test('full branded-source image and original authority artifacts bind without a circular package hash',async t=>{
 const f=await fixture(t),plan=await f.prepare();assert.equal(plan.fullImageVerified,true);assert.equal(plan.exactRequiredUidInventoryVerified,true);assert.equal(plan.originalArtifactHashesVerified,true);assert.equal(plan.sourceAuthSha256,authorityDigest(f.authExportJson));assert.equal(plan.sourceOperatorSha256,authorityDigest(f.operatorRecordsJson));assert.equal(plan.uidInventorySha256,authorityDigest(['employee_binding','manager_binding']));assert.equal(plan.imageManifestSha256,f.capture.manifestSha256);assert.equal(plan.authorityPackageSha256,authorityDigest(f.options.authorityEnvelope));assert.notEqual(plan.authorityPackageSha256,f.capture.dependencyPlan.supplied.authExport.sha256);assert.equal(plan.users,2);assert.equal(plan.activationAllowed,false);assert.equal(plan.productionRecoveryAccepted,false);assert.ok(Object.isFrozen(plan.context));assert.equal(JSON.stringify(plan).includes('passwordHash'),false);assert.equal(disposeImageBoundRecoveryAuthority(plan),true);assert.equal(disposeImageBoundRecoveryAuthority(plan),false);
});

test('wrong image key, missing/corrupt page, manifest digest or expected context reject before target access',async t=>{
 for(const mode of ['key','missing','corrupt','digest','context']){
  const f=await fixture(t);const image={...f.options.image,expected:{...f.options.image.expected}},page=[...f.objects.keys()].find(key=>key.includes('/pages/'));
  if(mode==='key')image.masterKey=randomBytes(32);if(mode==='missing')f.objects.delete(page);if(mode==='corrupt')f.objects.get(page)[20]^=1;if(mode==='digest')image.manifestSha256='0'.repeat(64);if(mode==='context')image.expected.tenantId='other_business';
  let targetAccess=0;const target={get auth(){targetAccess++;throw Error('must-not-access-target');}};
  await assert.rejects(restoreImageBoundAuthority({...f.options,image,target}),/image-|missing-image|expected-context|authentication/);assert.equal(targetAccess,0);
 }
});

test('authority final image/context and original raw-export digest mismatches fail',async t=>{
 for(const changed of [{authorityContext:{imageManifestSha256:'b'.repeat(64)}},{authorityContext:{imageId:'other_image'}},{authorityContext:{keyId:'another_original_key'}},{authorityContext:{readTime:'2026-11-07T06:00:00.000000Z'}},{authSha:'c'.repeat(64)},{operatorSha:'d'.repeat(64)}]){
  const f=await fixture(t,changed);await assert.rejects(f.prepare(),/context|source-auth-artifact|source-operator-artifact/);
 }
 const f=await fixture(t);await assert.rejects(f.prepare({authorityMasterKey:randomBytes(32)}),/authentication/);
});

function resealAuthority(f,change){
 const envelope=JSON.parse(f.options.authorityEnvelope),context=Buffer.from(canonical(envelope.context)),key=Buffer.from(hkdfSync('sha256',f.options.authorityMasterKey,context,Buffer.from('strawberry-recovery-authority-v1'),32));
 let plain;
 try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'));decipher.setAAD(context);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));plain=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);const payload=JSON.parse(plain);change(payload);const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(context);const ciphertext=Buffer.concat([cipher.update(Buffer.from(canonical(payload))),cipher.final()]);return Buffer.from(canonical({...envelope,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));}
 finally{key.fill(0);plain?.fill(0);}
}

test('a valid authority-key reseal cannot detach recovered rows from image-pinned original bytes',async t=>{
 const f=await fixture(t);
 for(const kind of ['auth','operator']){
  const authorityEnvelope=resealAuthority(f,payload=>{const key=kind==='auth'?'authExportBase64':'operatorRecordsBase64',raw=JSON.parse(Buffer.from(payload[key],'base64'));if(kind==='auth')raw.users[0].passwordHash=randomBytes(64).toString('base64');else raw[0].payload.trialEndMs=999999;payload[key]=json(raw).toString('base64');});
  await assert.rejects(f.prepare({authorityEnvelope}),/source-artifact-integrity/);
 }
 // Even a holder of the separate authority key who updates the asserted digest
 // cannot update the original export digest authenticated by the image key.
 for(const kind of ['auth','operator']){
  const authorityEnvelope=resealAuthority(f,payload=>{const key=kind==='auth'?'authExportBase64':'operatorRecordsBase64',raw=JSON.parse(Buffer.from(payload[key],'base64'));if(kind==='auth')raw.users[0].passwordHash=randomBytes(64).toString('base64');else raw[0].payload.trialEndMs=999999;const changed=json(raw);payload[key]=changed.toString('base64');payload[kind==='auth'?'sourceAuthSha256':'sourceOperatorSha256']=authorityDigest(changed);});
  await assert.rejects(f.prepare({authorityEnvelope}),new RegExp('source-'+kind+'-artifact'));
 }
});

test('required UID omissions, unrelated extra users and supplied inventory digest mismatch reject',async t=>{
 const absent=await fixture(t,{uids:['manager_binding'],sourceUids:['employee_binding','manager_binding']});await assert.rejects(absent.prepare(),/required-uid-inventory/);
 const extra=await fixture(t,{uids:['employee_binding','manager_binding','unrelated_business_user'],sourceUids:['employee_binding','manager_binding']});await assert.rejects(extra.prepare(),/required-uid-inventory/);
 const wrongDigest=await fixture(t,{authInventory:['employee_binding','manager_binding','extra_claimed_uid']});await assert.rejects(wrongDigest.prepare(),/supplied-uid-inventory/);
});

test('a financial image missing either original authority artifact cannot authorize disabled import',async t=>{
 const f=await fixture(t,{dependencies:false});await assert.rejects(f.prepare(),/original-authority-artifacts-required/);
});

test('caller mutation after first await cannot alter copied envelopes, keys, image reference or expected context',async t=>{
 const f=await fixture(t);let signal,release;const entered=new Promise(resolve=>{signal=resolve;}),gate=new Promise(resolve=>{release=resolve;});const originalRead=f.storage.read.bind(f.storage);let first=true;
 const supplier={async read(key,options){if(first){first=false;signal();await gate;}return originalRead(key,options);}};
 const image={...f.options.image,storage:supplier,expected:{...f.options.image.expected}},envelope=Buffer.from(f.options.authorityEnvelope),authorityKey=Buffer.from(f.options.authorityMasterKey),imageKey=Buffer.from(image.masterKey);image.masterKey=imageKey;
 const pending=prepareImageBoundRecoveryAuthority({image,authorityEnvelope:envelope,authorityMasterKey:authorityKey});await entered;envelope.fill(0);authorityKey.fill(0);imageKey.fill(0);image.expected.tenantId='mutated_business';image.manifestSha256='0'.repeat(64);image.manifestKey='mutated/path';supplier.read=()=>{throw Error('replaced-caller-method');};release();const plan=await pending;assert.equal(plan.imageManifestSha256,f.capture.manifestSha256);assert.equal(plan.context.tenantId,sourceContext.tenantId);assert.equal(plan.sourceAuthSha256,authorityDigest(f.authExportJson));disposeImageBoundRecoveryAuthority(plan);
});

test('byte/schema/aggregate-read/request/runtime limits fail closed without raising maxima',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.prepare({authorityEnvelope:new Uint8Array(AUTHORITY_BINDING_LIMITS.envelopeBytes+1)}),/byte-input/);
 for(const limits of [{totalImageReadBytes:1},{imageReads:1},{imageReadBytes:1}])await assert.rejects(f.prepare({limits}),/read-byte-limit|read-limit|invalid-argument/);
 await assert.rejects(f.prepare({limits:{runtimeMs:AUTHORITY_BINDING_LIMITS.runtimeMs+1}}),/invalid-argument/);
 await assert.rejects(f.prepare({limits:{unknown:1}}),/limit-option/);
 await assert.rejects(f.prepare({authorityMasterKey:new Uint8Array(new SharedArrayBuffer(32))}),/byte-input/);
 let clock=0;await assert.rejects(f.prepare({limits:{runtimeMs:100},monotonicNow:()=>clock+=60}),/deadline/);
 await assert.rejects(f.prepare({monotonicNow:()=>NaN}),/clock/);
});

test('individual read deadline never proceeds to target import even when its read completes late',async t=>{
 const f=await fixture(t);let settled=false;const original=f.storage.read.bind(f.storage),image={...f.options.image,storage:{async read(...args){await new Promise(resolve=>setTimeout(resolve,30));settled=true;return original(...args);}}};
 await assert.rejects(restoreImageBoundAuthority({...f.options,image,target:{},limits:{requestMs:5}}),/deadline/);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(settled,true);
});

test('cloned/disposed plans and attempted authority-option overrides cannot call a target',async t=>{
 const f=await fixture(t),plan=await f.prepare();await assert.rejects(restorePreparedImageBoundAuthority({target:{},plan:structuredClone(plan)}),/prepared-plan/);
 await assert.rejects(restorePreparedImageBoundAuthority({target:{},plan,restoreOptions:{expected:{}}}),/restore-option/);assert.equal(disposeImageBoundRecoveryAuthority(plan),true);await assert.rejects(restorePreparedImageBoundAuthority({target:{},plan}),/prepared-plan/);
});

test('a prepared capability is one-shot even when the separate demo target rejects it',async t=>{
 const f=await fixture(t),plan=await f.prepare();await assert.rejects(restorePreparedImageBoundAuthority({target:{},plan}),/owned-target-required/);await assert.rejects(restorePreparedImageBoundAuthority({target:{},plan}),/prepared-plan/);assert.equal(disposeImageBoundRecoveryAuthority(plan),false);
});
