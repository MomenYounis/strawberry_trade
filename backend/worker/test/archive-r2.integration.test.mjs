// Local workerd R2 API semantics, not acceptance of a real provider/account.
import test from 'node:test';import assert from 'node:assert/strict';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {R2ArchiveStorage,MirroredArchiveStorage} from '../../src/archive-storage.mjs';
test('workerd R2 conditional immutability, bounded reads, persisted restart and independent copy recovery',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'strawberry-local-r2-'));let mf;
 const options={name:'local_archive_acceptance',modules:true,script:'export default {fetch(){return new Response("local-only")}}',compatibilityDate:'2026-10-15',r2Buckets:['PRIMARY','RECOVERY'],r2Persist:folder};
 try{
  mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:folder});let primary=await mf.getR2Bucket('PRIMARY'),recovery=await mf.getR2Bucket('RECOVERY');
  let storage=new MirroredArchiveStorage(new R2ArchiveStorage(primary),new R2ArchiveStorage(recovery));
  const bytes=Buffer.from('synthetic ciphertext for local API acceptance'),key='archives/v1/tenant/2026/run/chunks/'+createHash('sha256').update(bytes).digest('hex');
  await storage.putImmutable(key,bytes);await storage.putImmutable(key,bytes);
  assert.deepEqual(await storage.read(key,{maxBytes:bytes.length}),bytes);await assert.rejects(storage.read(key,{maxBytes:bytes.length-1}),/download-limit/);
  await mf.dispose();mf=new Miniflare({...convertV4MiniflareOptions(options),resourcePersistencePath:folder});primary=await mf.getR2Bucket('PRIMARY');recovery=await mf.getR2Bucket('RECOVERY');storage=new MirroredArchiveStorage(new R2ArchiveStorage(primary),new R2ArchiveStorage(recovery));
  assert.deepEqual(await storage.read(key,{maxBytes:bytes.length}),bytes);await primary.delete(key);
  await assert.rejects(storage.read(key,{maxBytes:bytes.length}),/missing/);assert.deepEqual(await storage.readRecovery(key,{maxBytes:bytes.length}),bytes);
  await primary.put(key,Buffer.from('tampered'));await assert.rejects(storage.putImmutable(key,bytes),/immutable-object-conflict/);
  assert.equal(storage.productionDurabilityAccepted,false);
 }finally{await mf?.dispose();await rm(folder,{recursive:true,force:true});}
});
