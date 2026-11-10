// Real filesystem integration storage, explicitly unsuitable as production
// durability acceptance. Keys never become paths: immutable files use SHA(key).
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,lstat,open,link,unlink,chmod} from 'node:fs/promises';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {constants} from 'node:fs';
const prefix='strawberry-recovery-objects-',marker='.strawberry-recovery-object-owner.json',max=8_388_608;
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(reason){throw Error('recovery-object-local-'+reason);}
export async function readRecoveryObjectHandleBounded(handle,maxBytes){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>max)fail('limit');const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.size>maxBytes)fail('read-limit');
 // A final inode can be corrupted or grow after stat(). Never use readFile():
 // read at most the originally advertised size plus one sentinel byte.
 const buffer=Buffer.alloc(stat.size+1);let size=0;
 try{while(size<buffer.length){const part=await handle.read(buffer,size,Math.min(65_536,buffer.length-size),null);if(!part.bytesRead)break;size+=part.bytesRead;if(size>stat.size||size>maxBytes)fail('read-limit');}if(size!==stat.size||(await handle.stat()).size!==stat.size)fail('truncated');return buffer.subarray(0,size);}catch(error){buffer.fill(0);throw error;}
}
function keyCheck(key){if(typeof key!=='string'||key.length>512||! /^(?:archives\/v1\/[A-Za-z0-9_-]{1,120}\/\d{4}\/[A-Za-z0-9_-]{1,120}\/(?:chunks|manifests)|snapshots\/v1\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}\/(?:pages|manifests)|recovery-objects\/v1\/[A-Za-z0-9_-]{1,120}\/(?:catalogs|closures)|firestore-recovery\/v1\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/[A-Za-z0-9_-]{1,120}\/[A-Za-z0-9_-]{1,120}\/(?:pages|manifests))\/[a-f0-9]{64}$/.test(key))fail('key');}
export async function createRecoveryObjectLocalStorage({base=tmpdir()}={}){
 const directory=await mkdtemp(join(resolve(base),prefix));await chmod(directory,0o700);await writeFile(join(directory,marker),JSON.stringify({format:'strawberry-recovery-objects-local',version:1,uid:process.getuid()}),{flag:'wx',mode:0o600});return openRecoveryObjectLocalStorage({directory});
}
export async function openRecoveryObjectLocalStorage({directory}){
 if(typeof directory!=='string'||!basename(directory).startsWith(prefix))fail('directory');directory=resolve(directory);
 for(const path of [directory,join(directory,marker)]){const stat=await lstat(path);if(stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||path===directory&&!stat.isDirectory()||path!==directory&&(!stat.isFile()||stat.size>1024))fail('owner');}
 const markerHandle=await open(join(directory,marker),constants.O_RDONLY|constants.O_NOFOLLOW);let owner;try{owner=JSON.parse((await readRecoveryObjectHandleBounded(markerHandle,1024)).toString('utf8'));}finally{await markerHandle.close();}if(owner.format!=='strawberry-recovery-objects-local'||owner.version!==1||owner.uid!==process.getuid()||Object.keys(owner).length!==3)fail('owner');
 function path(key){keyCheck(key);return join(directory,hash(key)+'.object');}
 async function read(key,{maxBytes}){if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>max)fail('limit');const file=path(key),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{return await readRecoveryObjectHandleBounded(handle,maxBytes);}finally{await handle.close();}}
 return Object.freeze({directory,kind:'recovery-local-directory',synthetic:true,productionDurabilityAccepted:false,
  read,
  async putImmutable(key,bytes){const file=path(key);if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>max)fail('content-address');const body=Buffer.from(bytes);if(!key.endsWith('/'+hash(body)))fail('content-address');const temporary=join(directory,randomUUID()+'.unpublished');let handle;try{handle=await open(temporary,'wx',0o600);await handle.writeFile(body);await handle.sync();await handle.close();handle=null;try{await link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;const existing=await read(key,{maxBytes:body.length});if(!existing.equals(body))fail('immutable-conflict');}const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}return {key};}finally{body.fill(0);await handle?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}},
 });
}
