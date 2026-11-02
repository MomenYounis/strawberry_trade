import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {MirroredArchiveStorage,SyntheticArchiveStorage} from '../src/archive-storage.mjs';
test('independent archive copy readback, retry and primary-loss recovery remain synthetic',async()=>{
 const primary=new SyntheticArchiveStorage(),recovery=new SyntheticArchiveStorage();const storage=new MirroredArchiveStorage(primary,recovery);
 const bytes=Buffer.from('synthetic encrypted archive bytes'),key='archives/v1/t1/2026/run1/chunks/'+createHash('sha256').update(bytes).digest('hex');
 await storage.putImmutable(key,bytes);await storage.putImmutable(key,bytes);primary.objects.clear();
 await assert.rejects(storage.read(key,{maxBytes:1024}),/missing/);
 assert.deepEqual(await storage.readRecovery(key,{maxBytes:1024}),bytes);assert.equal(storage.productionDurabilityAccepted,false);
 await storage.putImmutable(key,bytes);assert.deepEqual(await storage.read(key,{maxBytes:1024}),bytes);
 const broken={putImmutable:async()=>{},read:async()=>Buffer.from('bad copy')};
 await assert.rejects(new MirroredArchiveStorage(primary,broken).putImmutable(key,bytes),/recovery-copy-mismatch/);
 assert.throws(()=>new MirroredArchiveStorage(primary,primary),/independent-storage/);
});
