// Filesystem integration adapter for synthetic acceptance only. Never a
// production archive, independent recovery copy or source of deletion evidence.
import {mkdtemp,mkdir,open,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ARCHIVE_LIMITS} from './archive-format.mjs';
import {integer} from './validation.mjs';
const valid=key=>typeof key==='string'&&/^archives\/v1\/[A-Za-z0-9_-]{1,120}\/\d{4}\/[A-Za-z0-9_-]{1,120}\/(chunks|manifests)\/[a-f0-9]{64}$/.test(key);
export async function createSyntheticDirectoryStorage() {
 const directory=await mkdtemp(join(tmpdir(),'strawberry-synthetic-objects-'));let destroyed=false;
 const path=key=>{if(destroyed||!valid(key))throw new Error('invalid-synthetic-object-key');return join(directory,key);};
 return Object.freeze({kind:'synthetic-directory',productionDurabilityAccepted:false,
  async putImmutable(key,bytes){
   const file=path(key);
   if(!(bytes instanceof Uint8Array)||bytes.byteLength>ARCHIVE_LIMITS.maxManifestBytes||!key.endsWith('/'+createHash('sha256').update(bytes).digest('hex')))throw new Error('invalid-content-address');
   await mkdir(join(file,'..'),{recursive:true,mode:0o700});
   let handle;
   try{handle=await open(file,'wx',0o600);await handle.writeFile(bytes);await handle.sync();}
   catch(error){if(error.code!=='EEXIST')throw error;const existing=await readFile(file);if(!existing.equals(Buffer.from(bytes)))throw new Error('immutable-object-conflict');}
   finally{await handle?.close();}
   return {key};
  },
  async read(key,{maxBytes}){
   integer(maxBytes,1,ARCHIVE_LIMITS.maxManifestBytes);const handle=await open(path(key),'r');
   try{const stat=await handle.stat();if(stat.size>maxBytes)throw new Error('archive-download-limit');const bytes=await handle.readFile();if(bytes.length!==stat.size||bytes.length>maxBytes)throw new Error('archive-object-truncated');return bytes;}finally{await handle.close();}
  },
  async destroy(){if(destroyed)return;destroyed=true;await rm(directory,{recursive:true,force:true});},
 });
}
