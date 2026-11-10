import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {
 RECOVERY_COORDINATOR_LIMITS,
 PROVIDER_RECOVERY_VERIFICATION_BLOCKERS,
 RECOVERY_DATA_CLASSIFICATION,
 describeRecoveryDataScope,
 createRecoveryCoordinatorDemoTarget,
 prepareRecoveryCoordinator,
 disposeRecoveryCoordinator,
 restorePreparedRecoveryCoordinator,
 restoreRecoveryCoordinatorDemo,
 activatePreparedRecoveryCoordinator,
 activateRecoveryCoordinatorDemo,
} from '../src/recovery-coordinator.mjs';
import {coordinatorFixture} from './recovery-coordinator-fixture.mjs';
import {authorityDigest} from '../src/recovery-authority-package.mjs';

test('prepareRecoveryCoordinator validates all three layers in preflight with zero writes and disposes key material cleanly',async t=>{
 const f=await coordinatorFixture(t);
 const plan=await prepareRecoveryCoordinator(f.options);
 assert.equal(plan.format,'strawberry-disabled-recovery-coordinator');
 assert.equal(plan.version,1);
 assert.equal(plan.users,f.users.length);
 assert.equal(plan.operatorRecords,f.operators.length);
 assert.equal(plan.objectCount,f.objects.length+2);
 assert.equal(plan.activationAllowed,false);
 assert.equal(plan.productionRecoveryAccepted,false);
 const destFiles=await readdir(f.destination.directory);
 assert.deepEqual(destFiles,['.strawberry-recovery-object-owner.json']);
 const journalFiles=(await readdir(f.journalDirectory)).sort();
 assert.deepEqual(journalFiles,['.strawberry-recovery-object-owner.json','progress.sqlite']);
 assert.equal(disposeRecoveryCoordinator(plan),true);
 assert.equal(disposeRecoveryCoordinator(plan),false);
});

test('prepareRecoveryCoordinator rejects wrong keys, mismatched Auth hashes, missing UIDs, and corrupt objects with zero writes',async t=>{
 {
  const f=await coordinatorFixture(t,{wrongAuthHash:true});
  await assert.rejects(prepareRecoveryCoordinator(f.options),/source-auth-artifact/);
  assert.deepEqual(await readdir(f.destination.directory),['.strawberry-recovery-object-owner.json']);
 }
 {
  const f=await coordinatorFixture(t,{missingUid:true});
  await assert.rejects(prepareRecoveryCoordinator(f.options),/required-uid-inventory/);
  assert.deepEqual(await readdir(f.destination.directory),['.strawberry-recovery-object-owner.json']);
 }
 {
  const f=await coordinatorFixture(t);
  await assert.rejects(
   prepareRecoveryCoordinator({...f.options,authorityMasterKey:randomBytes(32)}),
   /authentication/,
  );
  await assert.rejects(
   prepareRecoveryCoordinator({
    ...f.options,
    image:{...f.options.image,masterKey:randomBytes(32)},
   }),
   /authentication/,
  );
  await assert.rejects(
   prepareRecoveryCoordinator({
    ...f.options,
    objects:{
     ...f.options.objects,
     resolveArchiveKey:async()=>randomBytes(32),
    },
   }),
   /archive|authentication|mac/i,
  );
  assert.deepEqual(await readdir(f.destination.directory),['.strawberry-recovery-object-owner.json']);
 }
});

test('coordinator target and execution guards reject unowned targets, invalid limits, and disposed plans',async t=>{
 const f=await coordinatorFixture(t);
 assert.throws(()=>createRecoveryCoordinatorDemoTarget({credential:null}),/Local demo operators require project|credential/);
 await assert.rejects(
  prepareRecoveryCoordinator({...f.options,limits:{unknownLimit:1}}),
  /recovery-coordinator-limits/,
 );
 await assert.rejects(
  prepareRecoveryCoordinator({...f.options,limits:{runtimeMs:RECOVERY_COORDINATOR_LIMITS.runtimeMs+1}}),
  /invalid-argument/,
 );
 const plan=await prepareRecoveryCoordinator(f.options);
 disposeRecoveryCoordinator(plan);
 await assert.rejects(
  restorePreparedRecoveryCoordinator({
   target:{},
   plan,
   destinationDirectory:f.destination.directory,
   journalDirectory:f.journalDirectory,
  }),
  /recovery-coordinator-prepared-plan/,
 );
 await assert.rejects(
  restoreRecoveryCoordinatorDemo({...f.options,target:{}}),
  /recovery-coordinator-owned-target/,
 );
 await assert.rejects(
  activatePreparedRecoveryCoordinator({
   target:{},
   plan,
   destinationDirectory:f.destination.directory,
   journalDirectory:f.journalDirectory,
  }),
  /recovery-coordinator-prepared-plan/,
 );
 await assert.rejects(
  activateRecoveryCoordinatorDemo({...f.options,target:{}}),
  /recovery-coordinator-owned-target/,
 );
 assert.equal(authorityDigest(f.rows),f.sourceBefore);
});

test('recovery data scope and provider verification blockers explicitly separate server, backup, and lost device state',()=>{
 const scope=describeRecoveryDataScope();
 assert.deepEqual(scope,RECOVERY_DATA_CLASSIFICATION);
 assert.equal(Object.isFrozen(scope),true);
 assert.equal(Object.isFrozen(scope.serverRecoverable),true);
 assert.equal(Object.isFrozen(scope.requiresEncryptedPendingBackup),true);
 assert.equal(Object.isFrozen(scope.lostWithoutDeviceOrBackup),true);
 assert.ok(scope.serverRecoverable.includes('accepted_ledger_entries_and_sequence_history'));
 assert.ok(scope.requiresEncryptedPendingBackup.includes('unsynced_pending_outbox_operations_with_original_id_and_payload_hash'));
 assert.ok(scope.lostWithoutDeviceOrBackup.includes('unbacked_up_local_outbox_operations_never_acknowledged_by_server'));
 assert.equal(PROVIDER_RECOVERY_VERIFICATION_BLOCKERS.length,3);
});
