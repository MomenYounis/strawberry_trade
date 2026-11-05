import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {createPrivateScratch} from './private-scratch.mjs';
import {join} from 'node:path';
import {canonical,integer} from './validation.mjs';
import {ARCHIVE_LIMITS} from './archive-format.mjs';

function validateKey(key){if(typeof key!=='string'||key.length>512||!/^archives\/v1\/[A-Za-z0-9_-]+\/\d{4}\/[A-Za-z0-9_-]+\/(chunks|manifests)\/[a-f0-9]{64}$/.test(key))throw new Error('invalid-archive-object-key');}
function validateBody(key,bytes){validateKey(key);if(!(bytes instanceof Uint8Array)||bytes.byteLength>ARCHIVE_LIMITS.maxManifestBytes||!key.endsWith('/'+createHash('sha256').update(bytes).digest('hex')))throw new Error('invalid-content-address');}
async function deadline(promise,ms,onTimeout=()=>{}){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new Error('archive-storage-timeout'));},ms);})]);}finally{clearTimeout(timer);}}
async function readBounded(stream,maxBytes,onReader=()=>{}){
  const reader=stream.getReader(),parts=[];let size=0;
  onReader(reader);
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('archive-download-limit');parts.push(Buffer.from(value));}return Buffer.concat(parts,size);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// Uses the Worker R2 binding API, not a credential-bearing public URL. R2 does
// not supply historical-version retrieval here. Content addresses plus atomic
// If-None-Match:* prevent this adapter from overwriting an object. Storage
// administration can still delete/replace objects; independent recovery remains
// a separate acceptance gate, never inferred from an upload or provider ETag.
export class R2ArchiveStorage {
  constructor(bucket,{timeoutMs=15_000}={}){
    if(!bucket||typeof bucket.get!=='function'||typeof bucket.put!=='function')throw new Error('r2-binding-required');
    integer(timeoutMs,100,30_000);this.bucket=bucket;this.timeoutMs=timeoutMs;this.kind='r2';
    Object.defineProperty(this,'productionDurabilityAccepted',{value:false,enumerable:true});
  }
  async putImmutable(key,bytes){
    validateBody(key,bytes);
    const result=await deadline(this.bucket.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/octet-stream'}}),this.timeoutMs);
    if(result===null){const existing=await this.read(key,{maxBytes:bytes.byteLength});if(!Buffer.from(existing).equals(Buffer.from(bytes)))throw new Error('immutable-object-conflict');}
    return {key};
  }
  async read(key,{maxBytes}){
    validateKey(key);integer(maxBytes,1,ARCHIVE_LIMITS.maxManifestBytes);
    let cancelled=false,reader;
    return deadline((async()=>{
      const object=await this.bucket.get(key);
      // R2's binding does not expose an AbortSignal for get(). A late response
      // must still release its body rather than starting work after timeout.
      if(cancelled){await object?.body?.cancel().catch(()=>{});throw new Error('archive-storage-timeout');}
      if(!object?.body)throw new Error('archive-object-missing');
      if(!Number.isSafeInteger(object.size)||object.size<0||object.size>maxBytes){await object.body.cancel().catch(()=>{});throw new Error('archive-download-limit');}
      const bytes=await readBounded(object.body,maxBytes,value=>{reader=value;});if(bytes.byteLength!==object.size)throw new Error('archive-object-truncated');return bytes;
    })(),this.timeoutMs,()=>{cancelled=true;void reader?.cancel().catch(()=>{});});
  }
}

export class SyntheticArchiveStorage {
  constructor(){this.objects=new Map();this.kind='synthetic';Object.defineProperty(this,'productionDurabilityAccepted',{value:false,enumerable:true});}
  async putImmutable(key,bytes){validateBody(key,bytes);const old=this.objects.get(key);if(old&&!old.equals(Buffer.from(bytes)))throw new Error('immutable-object-conflict');this.objects.set(key,Buffer.from(bytes));return {key};}
  async read(key,{maxBytes}){validateKey(key);integer(maxBytes,1,ARCHIVE_LIMITS.maxManifestBytes);const bytes=this.objects.get(key);if(!bytes)throw new Error('archive-object-missing');if(bytes.length>maxBytes)throw new Error('archive-download-limit');return Buffer.from(bytes);}
}

// Independently configured primary/recovery adapters. A successful write must
// survive a bounded readback from BOTH stores. This supplies local integration
// semantics, not evidence about provider independence, retention or key custody.
export class MirroredArchiveStorage {
  constructor(primary,recovery){
    if(!primary||!recovery||primary===recovery||[primary,recovery].some(s=>typeof s.putImmutable!=='function'||typeof s.read!=='function'))throw Error('independent-storage-adapters-required');
    this.primary=primary;this.recovery=recovery;this.kind='mirrored';
    Object.defineProperty(this,'productionDurabilityAccepted',{value:false,enumerable:true});
  }
  async putImmutable(key,bytes){
    validateBody(key,bytes);
    for(const storage of [this.primary,this.recovery]){
      await storage.putImmutable(key,bytes);
      const observed=await storage.read(key,{maxBytes:bytes.byteLength});
      if(!Buffer.from(observed).equals(Buffer.from(bytes)))throw Error('recovery-copy-mismatch');
    }
    return {key};
  }
  read(key,options){return this.primary.read(key,options);}
  readRecovery(key,options){return this.recovery.read(key,options);}
}

// Development/private verifier sink only. No public directory, no live DB, no
// user/account recreation. Process crashes can leave private temporary data;
// production still requires accepted encrypted scratch storage; the marker sweeper
// removes only sufficiently old scratch belonging to a dead process.
export async function createTemporaryRestoreSink(){
  const scratch=await createPrivateScratch('archive_restore'),directory=scratch.directory;
  let file;try{file=await open(join(directory,'records.ndjson'),'wx',0o600);}catch(e){await scratch.destroy();throw e;}
  let destroyed=false;
  return {isolated:true,async append(record){if(destroyed)throw new Error('restore-sink-closed');await file.write(canonical(record)+'\n');},async destroy(){if(destroyed)return;destroyed=true;try{await file.close();}finally{await scratch.destroy();}}};
}
