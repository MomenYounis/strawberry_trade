// Copies exact authenticated object bytes into an immutable quarantine store.
// This never activates a catalog, decrypts into a live ledger or grants deletion.
import {createHash} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {verifyFirestoreRecoveryImage} from './firestore-recovery-image.mjs';
import {freezeRecoveryValue} from './firestore-recovery-source.mjs';
import {readArchiveManifest} from './archive-format.mjs';
import {validateSnapshotHeader,validateSnapshotPage,snapshotHash,snapshotContentHash} from './active-snapshot-format.mjs';

export const RECOVERY_OBJECT_LIMITS=Object.freeze({objects:40_000,objectBytes:1_048_576,metadataBytes:8_388_608,totalBytes:536_870_912,ioBytes:4_294_967_296,requests:200_000,runtimeMs:1_800_000,requestMs:30_000});
const hex=/^[a-f0-9]{64}$/,prepared=new WeakMap();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),digest=value=>hash(Buffer.from(canonical(value)));
function fail(reason){throw Error('recovery-object-'+reason);}
function exact(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('schema');}
function json(value,depth=0,state={nodes:0}){if(depth>24||++state.nodes>600_000)fail('json-limit');if(value===null||typeof value==='string'||typeof value==='boolean')return;if(typeof value==='number'){if(!Number.isSafeInteger(value))fail('number');return;}if(!value||typeof value!=='object'||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)fail('json');for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))fail('property');json(child,depth+1,state);}}
// Bound the JSON graph before JSON.parse can allocate it. UTF-8 decoding itself
// is limited by the byte cap; this scan never constructs token/string arrays.
function preparse(raw){let depth=0,nodes=0;for(let index=0;index<raw.length;index++){const char=raw[index];if(/\s/.test(char))continue;if(char==='{'||char==='['){if(++depth>24||++nodes>600_000)fail('preparse-limit');}else if(char==='}'||char===']'){if(--depth<0)fail('json');}else if(char==='"'){if(++nodes>600_000)fail('preparse-limit');let closed=false;for(index++;index<raw.length;index++){if(raw.charCodeAt(index)<32)fail('json');if(raw[index]==='\\'){index++;continue;}if(raw[index]==='"'){closed=true;break;}}if(!closed)fail('json');}else if(char===','||char===':')continue;else{if(!/[0-9tfn-]/.test(char)||++nodes>600_000)fail('preparse-limit');const start=index;while(index+1<raw.length&&!/[\s,\]}]/.test(raw[index+1]))index++;if(index-start>64)fail('preparse-limit');}}if(depth!==0)fail('json');}
function parse(bytes,max){if(!(bytes instanceof Uint8Array)||bytes.length>max)fail('byte-limit');let raw,value;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('json');}preparse(raw);try{value=JSON.parse(raw);}catch{fail('json');}json(value);if(canonical(value)!==raw)fail('noncanonical');return value;}
function same(a,b){return canonical(a)===canonical(b);}
function ref(value){exact(value,['key','sha256']);if(typeof value.key!=='string'||!hex.test(value.sha256))fail('reference');return {key:value.key,sha256:value.sha256};}
function objectKey(key,tenant){
 if(typeof key!=='string'||key.length>512)fail('key');
 const match=/^(archives\/v1\/([A-Za-z0-9_-]{1,120})\/([0-9]{4})\/([A-Za-z0-9_-]{1,120})\/(chunks|manifests)|snapshots\/v1\/([A-Za-z0-9_-]{1,120})\/([A-Za-z0-9_-]{1,120})\/(pages|manifests))\/([a-f0-9]{64})$/.exec(key);
 if(!match||(match[2]??match[6])!==tenant)fail('key-scope');
 return {kind:match[2]?'archive':'snapshot',part:match[5]??match[8],year:match[3]?Number(match[3]):undefined,runId:match[4]??match[7],sha256:match[9]};
}
function artifactKey(key,tenant,type,sha256){if(key!==`recovery-objects/v1/${tenant}/${type}/${sha256}`)fail('artifact-key');}
function limited(options={}){const values={...RECOVERY_OBJECT_LIMITS,...options};if(Object.keys(options).some(key=>!Object.hasOwn(RECOVERY_OBJECT_LIMITS,key)))fail('limit-option');for(const [key,value]of Object.entries(values))integer(value,1,RECOVERY_OBJECT_LIMITS[key]);return Object.freeze(values);}
function budget(limits,monotonicNow=()=>performance.now()){
 const start=monotonicNow();if(!Number.isFinite(start))fail('clock');let last=start,requests=0,ioBytes=0;
 function check(){const current=monotonicNow();if(!Number.isFinite(current)||current<last)fail('clock');last=current;if(current-start>=limits.runtimeMs)fail('deadline');}
 async function timed(action){check();if(++requests>limits.requests)fail('request-limit');let timer;try{const result=await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('recovery-object-deadline')),Math.min(limits.requestMs,limits.runtimeMs-(last-start)));})]);check();return result;}finally{clearTimeout(timer);}}
 async function read(storage,key,maxBytes,expectedHash=null,expectedBytes=null){if(typeof storage?.read!=='function')fail('storage');const bytes=await timed(()=>storage.read(key,{maxBytes}));if(!(bytes instanceof Uint8Array)||bytes.length>maxBytes||expectedBytes!==null&&bytes.length!==expectedBytes||expectedHash!==null&&hash(bytes)!==expectedHash)fail('integrity');ioBytes+=bytes.length;if(ioBytes>limits.ioBytes)fail('io-limit');return bytes;}
 async function put(storage,key,bytes,track=()=>{}){if(typeof storage?.putImmutable!=='function')fail('immutable-storage');if(ioBytes+bytes.length>limits.ioBytes)fail('io-limit');ioBytes+=bytes.length;await timed(()=>{const body=Buffer.from(bytes);track(1);const pending=Promise.resolve().then(()=>storage.putImmutable(key,body));const settled=()=>{body.fill(0);track(-1);};pending.then(settled,settled);return pending;});check();}
 return {check,timed,read,put,statistics:()=>({requests,ioBytes})};
}
function inventoryObject(item,tenant,limits){
 exact(item,['key','sha256','bytes','children','keyIds']);const identity=ref({key:item.key,sha256:item.sha256}),kind=objectKey(item.key,tenant);if(kind.sha256!==item.sha256)fail('content-address');integer(item.bytes,1,limits.objectBytes);
 if(!Array.isArray(item.children)||item.children.length>limits.objects||!Array.isArray(item.keyIds)||item.keyIds.length>256)fail('inventory-limit');
 const children=item.children.map(child=>{const value=ref(child);if(objectKey(value.key,tenant).sha256!==value.sha256)fail('content-address');return value;});
 if(new Set(children.map(child=>child.key)).size!==children.length)fail('duplicate-child');
 for(const key of item.keyIds)id(key);if(!same(item.keyIds,[...new Set(item.keyIds)].sort()))fail('key-inventory');
 return {...identity,bytes:item.bytes,children,keyIds:item.keyIds};
}
const oldInventory=item=>({key:item.key,sha256:item.sha256,children:item.children,keyIds:item.keyIds});
function requiredChildren(item,children,keyIds){if(!same(item.children,children)||!same(item.keyIds,keyIds))fail('manifest-closure-mismatch');}
function closureGraph(objects,roots){
 const states=new Map(),reachable=new Set();
 // Iterative DFS prevents an untrusted 40k-deep graph from exhausting the stack.
 for(const root of roots){const stack=[{ref:root,exit:false}];while(stack.length){const current=stack.pop(),item=objects.get(current.ref.key);if(!item||item.sha256!==current.ref.sha256)fail('missing-child');if(current.exit){states.set(item.key,2);continue;}const state=states.get(item.key);if(state===1)fail('cycle');if(state===2)continue;states.set(item.key,1);reachable.add(item.key);stack.push({ref:current.ref,exit:true});for(let index=item.children.length-1;index>=0;index--)stack.push({ref:item.children[index],exit:false});}}
 if(reachable.size!==objects.size)fail('unreferenced-object');
}

// Artifact encodings are explicit: the legacy inventory hash excludes bytes,
// while the MAC-bound artifact SHA binds every exact size as well as that hash.
export function encodeRecoveryObjectArtifacts({source,objectRoots,objects}){
 json({source,objectRoots,objects});const tenant=id(source.tenantId);
 if(!Array.isArray(objectRoots)||objectRoots.length>RECOVERY_OBJECT_LIMITS.objects||!Array.isArray(objects)||objects.length>RECOVERY_OBJECT_LIMITS.objects)fail('inventory-limit');
 const normalized=objects.map(item=>inventoryObject(item,tenant,RECOVERY_OBJECT_LIMITS)).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 const catalog=Buffer.from(canonical({format:'strawberry-recovery-object-catalog',version:1,source,objectRoots:objectRoots.map(ref)}));
 const closure=Buffer.from(canonical({format:'strawberry-recovery-object-closure',version:1,source,objects:normalized}));
 if(catalog.length>RECOVERY_OBJECT_LIMITS.metadataBytes||closure.length>RECOVERY_OBJECT_LIMITS.metadataBytes)fail('metadata-limit');
 const common={...source},catalogSha256=hash(catalog),closureSha256=hash(closure);
 return {catalog,closure,snapshotCatalog:{...common,key:`recovery-objects/v1/${tenant}/catalogs/${catalogSha256}`,sha256:catalogSha256,objectRoots:objectRoots.map(ref)},objectClosure:{...common,key:`recovery-objects/v1/${tenant}/closures/${closureSha256}`,sha256:closureSha256,objects:normalized.map(oldInventory)}};
}

export async function prepareRecoveryObjectCopy({image,sourceStorage,resolveArchiveKey,limits:options={},monotonicNow}){
 const limits=limited(options),guard=budget(limits,monotonicNow);
 if(!image||typeof resolveArchiveKey!=='function')fail('arguments');
 const verified=await verifyFirestoreRecoveryImage({...image,storage:{read:(key,{maxBytes})=>guard.read(image.storage,key,Math.min(maxBytes,limits.metadataBytes))}});
 const plan=verified.dependencyPlan,source=plan.source,tenant=source.tenantId,catalogRef=plan.supplied.snapshotCatalog,closureRef=plan.supplied.objectClosure;
 if(!catalogRef||!closureRef)fail('dependency-artifacts-required');
 artifactKey(catalogRef.key,tenant,'catalogs',catalogRef.sha256);artifactKey(closureRef.key,tenant,'closures',closureRef.sha256);
 const catalogBytes=await guard.read(sourceStorage,catalogRef.key,limits.metadataBytes,catalogRef.sha256),catalog=parse(catalogBytes,limits.metadataBytes);
 const closureBytes=await guard.read(sourceStorage,closureRef.key,limits.metadataBytes,closureRef.sha256),closure=parse(closureBytes,limits.metadataBytes);
 exact(catalog,['format','version','source','objectRoots']);exact(closure,['format','version','source','objects']);
 if(catalog.format!=='strawberry-recovery-object-catalog'||closure.format!=='strawberry-recovery-object-closure'||catalog.version!==1||closure.version!==1||!same(source,catalog.source)||!same(source,closure.source))fail('artifact-context');
 if(!Array.isArray(catalog.objectRoots)||catalog.objectRoots.length>limits.objects||!Array.isArray(closure.objects)||closure.objects.length>limits.objects)fail('object-limit');
 const snapshotRoots=catalog.objectRoots.map(ref);if(digest(snapshotRoots)!==catalogRef.rootInventorySha256)fail('catalog-inventory');
 const objects=new Map();let totalBytes=0;
 for(const value of closure.objects){guard.check();const item=inventoryObject(value,tenant,limits);if(objects.has(item.key))fail('duplicate-object');objects.set(item.key,item);if((totalBytes+=item.bytes)>limits.totalBytes)fail('total-limit');}
 const sorted=[...objects.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 if(digest(sorted.map(oldInventory))!==closureRef.objectInventorySha256)fail('closure-inventory');
 const roots=[...plan.required.objectRoots,...snapshotRoots].map(ref);for(const root of roots)if(objectKey(root.key,tenant).sha256!==root.sha256)fail('content-address');
 closureGraph(objects,roots);
 const keyIds=[...new Set([...plan.required.keyIds,...sorted.flatMap(item=>item.keyIds)])].sort();if(!same(keyIds,closureRef.requiredKeyIds))fail('required-key-inventory');
 const snapshotPages=new Map(),archiveChunks=new Set();
 for(const item of sorted){guard.check();const kind=objectKey(item.key,tenant);
  if(kind.part==='manifests'&&kind.kind==='archive'){
   const bytes=await guard.read(sourceStorage,item.key,item.bytes,item.sha256,item.bytes),envelope=parse(bytes,limits.objectBytes),keyId=envelope?.body?.context?.keyId;id(keyId);
   const masterKey=await guard.timed(()=>resolveArchiveKey(keyId));if(!(masterKey instanceof Uint8Array)||masterKey.length!==32)fail('original-key-required');
   const manifest=await readArchiveManifest({storage:{read:(key,{maxBytes})=>guard.read(sourceStorage,key,Math.min(maxBytes,limits.objectBytes))},manifestKey:item.key,manifestSha256:item.sha256,masterKey,expected:{tenantId:tenant,year:kind.year,runId:kind.runId,keyId}});
   requiredChildren(item,manifest.chunks.map(chunk=>({key:chunk.key,sha256:chunk.cipherSha256})),[keyId]);
   for(const chunk of manifest.chunks){const child=objects.get(chunk.key);if(!child||child.bytes!==chunk.cipherBytes||!same(child.keyIds,[keyId]))fail('chunk-closure-mismatch');archiveChunks.add(chunk.key);}
  }else if(kind.part==='manifests'&&kind.kind==='snapshot'){
   const publication=parse(await guard.read(sourceStorage,item.key,item.bytes,item.sha256,item.bytes),limits.objectBytes);
   if(!publication||Object.keys(publication).some(key=>!['header','headerSha256','pages','historyFloor'].includes(key))||!['header','headerSha256','pages'].every(key=>Object.hasOwn(publication,key)))fail('snapshot-publication');
   const header=validateSnapshotHeader(publication.header,{tenantId:tenant,snapshotId:kind.runId});
   if(snapshotHash(header)!==publication.headerSha256||!Array.isArray(publication.pages)||publication.pages.length!==header.pageCount)fail('snapshot-publication');
   if(publication.historyFloor!==undefined)integer(publication.historyFloor,header.historyFloor,header.checkpointSequence);
   let count=0;const children=[];
   for(const [index,page]of publication.pages.entries()){
    exact(page,['index','key','sha256','recordCount']);if(page.index!==index||!hex.test(page.sha256))fail('snapshot-descriptor');integer(page.recordCount,1,500_000);count+=page.recordCount;
    const child=objects.get(page.key),identity=objectKey(page.key,tenant);if(identity.kind!=='snapshot'||identity.part!=='pages'||identity.runId!==kind.runId||!child||child.children.length||child.keyIds.length)fail('snapshot-page-closure');
    children.push({key:page.key,sha256:identity.sha256});const prior=snapshotPages.get(page.key);if(prior&&!same(prior,{header,index,sha256:page.sha256,recordCount:page.recordCount}))fail('snapshot-page-conflict');snapshotPages.set(page.key,{header,index,sha256:page.sha256,recordCount:page.recordCount});
   }
   if(count!==header.recordCount||snapshotContentHash(publication.pages)!==header.contentSha256)fail('snapshot-descriptor');requiredChildren(item,children,[]);
  }else if(item.children.length)fail('leaf-children');
 }
 for(const item of sorted){const kind=objectKey(item.key,tenant);if(kind.part==='chunks'&&!archiveChunks.has(item.key)||kind.part==='pages'&&!snapshotPages.has(item.key))fail('leaf-without-manifest');}
 // Pages are checked individually plus global sequence/ID uniqueness in a
 // bounded SQLite consumer downstream; copy acceptance is byte integrity only.
 for(const [key,expected]of snapshotPages){const item=objects.get(key),page=validateSnapshotPage(parse(await guard.read(sourceStorage,key,item.bytes,item.sha256,item.bytes),limits.objectBytes),expected.header,expected.index);if(page.sha256!==expected.sha256||page.records.length!==expected.recordCount)fail('snapshot-page-integrity');}
 // Preserve the exact catalog and closure bytes as well as their descendants;
 // an inventory hash on its own is not a restored catalog or usable evidence.
 const copyObjects=[...sorted,{key:catalogRef.key,sha256:catalogRef.sha256,bytes:catalogBytes.length,children:[],keyIds:[]},{key:closureRef.key,sha256:closureRef.sha256,bytes:closureBytes.length,children:[],keyIds:[]}].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 totalBytes+=catalogBytes.length+closureBytes.length;if(copyObjects.length>limits.objects||totalBytes>limits.totalBytes)fail('total-limit');
 const binding={format:'strawberry-recovery-object-copy',version:1,source,imageManifestSha256:image.manifestSha256,catalogSha256:catalogRef.sha256,closureSha256:closureRef.sha256,roots,objectInventorySha256:digest(copyObjects),objectCount:copyObjects.length,totalBytes,keyIds,activationAllowed:false,productionRecoveryAccepted:false};
 const value=freezeRecoveryValue({...binding,copyPlanSha256:digest(binding)});prepared.set(value,{objects:copyObjects,sourceStorage,limits,pendingWrites:0,active:false});return value;
}

function initialProgress(plan){return {format:'strawberry-recovery-object-progress',version:1,copyPlanSha256:plan.copyPlanSha256,nextObject:0,bytes:0,prefixSha256:hash(Buffer.alloc(0)),state:'copying',activationAllowed:false,productionRecoveryAccepted:false};}
function progressCheck(progress,plan,objects){exact(progress,Object.keys(initialProgress(plan)));if(progress.format!=='strawberry-recovery-object-progress'||progress.version!==1||progress.copyPlanSha256!==plan.copyPlanSha256||!['copying','verified_quarantine'].includes(progress.state)||progress.activationAllowed!==false||progress.productionRecoveryAccepted!==false||!hex.test(progress.prefixSha256))fail('journal-conflict');integer(progress.nextObject,0,objects.length);integer(progress.bytes,0,plan.totalBytes);const prefix=objects.slice(0,progress.nextObject),bytes=prefix.reduce((sum,item)=>sum+item.bytes,0),hasher=createHash('sha256');for(const item of prefix)hasher.update(canonical(item)).update('\n');if(bytes!==progress.bytes||hasher.digest('hex')!==progress.prefixSha256||progress.state==='verified_quarantine'&&progress.nextObject!==objects.length)fail('journal-progress');}
export async function verifyRecoveryObjectDestination({plan,destinationStorage,limits:options={},monotonicNow}){
 const state=prepared.get(plan);if(!state)fail('prepared-plan-required');const limits=limited({...state.limits,...options}),guard=budget(limits,monotonicNow);
 for(const item of state.objects)await guard.read(destinationStorage,item.key,item.bytes,item.sha256,item.bytes);
 return Object.freeze({copyPlanSha256:plan.copyPlanSha256,objects:plan.objectCount,bytes:plan.totalBytes,keyIds:plan.keyIds,byteIntegrityVerified:true,activationAllowed:false,productionRecoveryAccepted:false,...guard.statistics()});
}
export async function copyRecoveryObjects({plan,destinationStorage,journal,maxObjectsPerInvocation=null,monotonicNow}){
 const state=prepared.get(plan);if(!state||typeof journal?.load!=='function'||typeof journal?.compareAndSwap!=='function'||destinationStorage===state.sourceStorage)fail('copy-arguments');maxObjectsPerInvocation??=state.limits.objects;integer(maxObjectsPerInvocation,1,state.limits.objects);
 if(state.active||state.pendingWrites)fail('copy-still-in-flight');state.active=true;
 try{
 const guard=budget(state.limits,monotonicNow);let progress=await guard.timed(()=>journal.load(plan.copyPlanSha256));if(progress)progressCheck(progress,plan,state.objects);else{const next=initialProgress(plan);await guard.timed(()=>journal.compareAndSwap(plan.copyPlanSha256,null,next));progress=next;}
 const prefix=createHash('sha256');for(const item of state.objects.slice(0,progress.nextObject)){await guard.read(destinationStorage,item.key,item.bytes,item.sha256,item.bytes);prefix.update(canonical(item)).update('\n');}
 let copied=0;
 while(progress.nextObject<state.objects.length&&copied<maxObjectsPerInvocation){const item=state.objects[progress.nextObject],bytes=await guard.read(state.sourceStorage,item.key,item.bytes,item.sha256,item.bytes);try{await guard.put(destinationStorage,item.key,bytes,change=>{state.pendingWrites+=change;});await guard.read(destinationStorage,item.key,item.bytes,item.sha256,item.bytes);}finally{bytes.fill(0);}prefix.update(canonical(item)).update('\n');const next={...progress,nextObject:progress.nextObject+1,bytes:progress.bytes+item.bytes,prefixSha256:prefix.copy().digest('hex')};await guard.timed(()=>journal.compareAndSwap(plan.copyPlanSha256,progress,next));progress=next;copied++;}
 if(progress.nextObject===state.objects.length){
  // Independent full reread, including objects copied during this invocation.
  for(const item of state.objects)await guard.read(destinationStorage,item.key,item.bytes,item.sha256,item.bytes);
  const next={...progress,state:'verified_quarantine'};if(!same(next,progress))await guard.timed(()=>journal.compareAndSwap(plan.copyPlanSha256,progress,next));progress=next;
 }
 return Object.freeze({...progress,objectsCopiedThisInvocation:copied,complete:progress.state==='verified_quarantine',...guard.statistics()});
 }finally{state.active=false;}
}
