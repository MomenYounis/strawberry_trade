import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {readdir,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {canonical} from '../src/validation.mjs';
import {authorityDigest} from '../src/recovery-authority-package.mjs';
import {
 createRecoveryCoordinatorDemoTarget,
 restoreRecoveryCoordinatorDemo,
 activateRecoveryCoordinatorDemo,
 PROVIDER_RECOVERY_VERIFICATION_BLOCKERS,
 RECOVERY_DATA_CLASSIFICATION,
} from '../src/recovery-coordinator.mjs';
import {coordinatorFixture} from './recovery-coordinator-fixture.mjs';

assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:18180');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,'127.0.0.1:19199');

const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
const credential={
 project_id:DEMO_PROJECT_ID,
 client_email:'synthetic-coordinator@'+DEMO_PROJECT_ID+'.iam.gserviceaccount.com',
 private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
};
const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert(credential)},'coordinator-oracle-'+randomBytes(6).toString('hex'));
const auth=getAuth(app);
const db=initializeFirestore(app,{preferRest:true});
db.settings({host:'127.0.0.1:18180',ssl:false,...emulatorFirestoreSettings(DEMO_PROJECT_ID,process.env)});
after(()=>deleteApp(app));

function target(t){
 const value=createRecoveryCoordinatorDemoTarget({credential});
 t.after(()=>value.close());
 return value;
}
async function userAbsent(uid){
 try{await auth.getUser(uid);return false;}
 catch(e){assert.equal(e.code,'auth/user-not-found');return true;}
}
async function verifyQuarantinedUsers(f){
 for(const u of f.users){
  const found=await auth.getUser(u.localId);
  assert.equal(found.uid,u.localId);
  assert.equal(found.email,u.email);
  assert.equal(found.disabled,true);
  assert.deepEqual(found.customClaims??{},{});
  assert.equal(Buffer.from(found.passwordHash,'base64').toString('hex'),Buffer.from(u.passwordHash,'base64').toString('hex'));
  assert.equal(Buffer.from(found.passwordSalt,'base64').toString('hex'),Buffer.from(u.salt,'base64').toString('hex'));
 }
}
async function verifyActivatedUsers(f){
 for(const u of f.users){
  const found=await auth.getUser(u.localId);
  assert.equal(found.uid,u.localId);
  assert.equal(found.email,u.email);
  assert.equal(found.disabled,false);
  assert.deepEqual(found.customClaims??{},JSON.parse(u.customAttributes));
  assert.equal(Buffer.from(found.passwordHash,'base64').toString('hex'),Buffer.from(u.passwordHash,'base64').toString('hex'));
  assert.equal(Buffer.from(found.passwordSalt,'base64').toString('hex'),Buffer.from(u.salt,'base64').toString('hex'));
 }
}

test('ordering, quarantine recovery, coordinated activation, tenant isolation, and duplicate retries',async t=>{
 const f=await coordinatorFixture(t);
 // Seed an unrelated live tenant, operator record, and Auth user to prove tenant isolation.
 const otherId='unrelated_'+randomBytes(6).toString('hex');
 const otherUid='user_'+otherId;
 await auth.createUser({uid:otherUid,email:otherUid+'@example.invalid',password:'UnrelatedSyntheticPass123!',disabled:false,displayName:'Other Tenant Owner'});
 await auth.setCustomUserClaims(otherUid,{admin:true,tenant:otherId});
 await db.doc('tenants/'+otherId).create({ownerUid:otherUid,enabled:true,sequence:9,trialStartMs:1,trialEndMs:999});
 await db.doc('tenants/'+otherId+'/members/'+otherUid).create({uid:otherUid,role:'manager',active:true});
 await db.doc('tenants/'+otherId+'/entries/other_sale').create({tenantId:otherId,creatorUid:otherUid,kind:'sale',totalMinor:4700,paidMinor:0});
 await db.doc('adminOperations/'+otherId).create({tenantId:otherId,type:'activate-license',entitlementEpoch:2});
 const captureOtherState=async()=>canonical({
  user:(await auth.getUser(otherUid)).toJSON(),
  root:(await db.doc('tenants/'+otherId).get()).data(),
  member:(await db.doc('tenants/'+otherId+'/members/'+otherUid).get()).data(),
  entry:(await db.doc('tenants/'+otherId+'/entries/other_sale').get()).data(),
  op:(await db.doc('adminOperations/'+otherId).get()).data(),
 });
 const otherBefore=await captureOtherState();

 // 1. Quarantine restore runs in exact phase order: objects -> financial -> authority.
 const restorePhases=[];
 const restored=await restoreRecoveryCoordinatorDemo({
  ...f.options,
  target:target(t),
  afterPhase:async event=>{restorePhases.push(event.phase);},
 });
 assert.equal(restored.state,'verified_disabled_recovery');
 assert.equal(restored.phase,'complete');
 assert.deepEqual(restorePhases,['objects','financial','authority']);
 assert.equal(restored.enabled,false);
 assert.equal(restored.activationAllowed,false);
 assert.equal(restored.allLayerTargetsVerified,true);
 await verifyQuarantinedUsers(f);
 assert.equal((await db.doc('tenants/'+f.context.tenantId).get()).exists,false);
 assert.equal((await db.doc(f.operators[0].path).get()).exists,false);

 // Duplicate retry of quarantine restore is idempotent and preserves quarantined state.
 const restoredAgain=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
 assert.equal(restoredAgain.state,'verified_disabled_recovery');
 await verifyQuarantinedUsers(f);
 assert.equal(await captureOtherState(),otherBefore);

 // 2. Coordinated activation transitions quarantine to an operational recovered tenant in exact order.
 const activatePhases=[];
 const activated=await activateRecoveryCoordinatorDemo({
  ...f.options,
  target:target(t),
  afterPhase:async event=>{activatePhases.push(event.phase);},
 });
 assert.equal(activated.state,'activated_demo_recovery');
 assert.equal(activated.phase,'complete');
 assert.deepEqual(activatePhases,['activating_objects','activating_financial','activating_authority']);
 assert.equal(activated.enabled,true);
 assert.equal(activated.operationalTenantActivated,true);
 assert.equal(activated.quarantinePreserved,true);
 assert.equal(activated.productionRecoveryAccepted,false);
 assert.deepEqual(activated.providerVerificationBlockers,PROVIDER_RECOVERY_VERIFICATION_BLOCKERS);
 assert.deepEqual(activated.recoveryScope,RECOVERY_DATA_CLASSIFICATION);

 await verifyActivatedUsers(f);
 const liveRoot=db.doc('tenants/'+f.context.tenantId);
 assert.equal((await liveRoot.get()).data().enabled,true);
 assert.equal((await liveRoot.get()).data().sequence,30);
 const liveEntries=(await liveRoot.collection('entries').get()).docs.map(d=>d.data());
 assert.equal(liveEntries.length,26);
 assert.equal((await liveRoot.collection('operations').doc('accepted_sale').get()).data().result.sequence,30);
 assert.equal((await liveRoot.collection('archiveRuns').doc('year_2026').get()).data().manifest.sha256,f.exported.manifestSha256);
 assert.deepEqual((await db.doc(f.operators[0].path).get()).data(),f.operators[0].payload);

 // Quarantine records remain preserved after activation.
 const qRoot=db.doc('firestoreRecoveryQuarantine/'+f.authorityContext.imageId+'/tenants/'+f.context.tenantId);
 assert.equal((await qRoot.get()).data().enabled,false);

 // Duplicate retry of coordinated activation is idempotent and does not mutate live records or other tenants.
 const rootUpdateBefore=(await liveRoot.get()).updateTime.toMillis();
 const opUpdateBefore=(await db.doc(f.operators[0].path).get()).updateTime.toMillis();
 const userBefore=(await auth.getUser(f.users[0].localId)).toJSON();
 const activatedAgain=await activateRecoveryCoordinatorDemo({...f.options,target:target(t)});
 assert.equal(activatedAgain.state,'activated_demo_recovery');
 assert.equal((await liveRoot.get()).updateTime.toMillis(),rootUpdateBefore);
 assert.equal((await db.doc(f.operators[0].path).get()).updateTime.toMillis(),opUpdateBefore);
 assert.deepEqual((await auth.getUser(f.users[0].localId)).toJSON(),userBefore);

 // Re-running disabled quarantine restore after activation is rejected so live accounts are not re-disabled.
 await assert.rejects(
  restoreRecoveryCoordinatorDemo({...f.options,target:target(t)}),
  /recovery-coordinator-journal-binding/,
 );
 await verifyActivatedUsers(f);
 assert.equal(await captureOtherState(),otherBefore);
 assert.equal(authorityDigest(f.rows),f.sourceBefore);
});

test('preflight failures and pre-existing collisions perform zero target or live writes',async t=>{
 // 1. Activation before quarantine restore is rejected with zero writes.
 {
  const f=await coordinatorFixture(t);
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-quarantine-not-verified/,
  );
  assert.equal((await db.doc('tenants/'+f.context.tenantId).get()).exists,false);
  assert.equal((await db.doc('recoveryCoordinatorActivations/'+f.authorityContext.imageId).get()).exists,false);
  for(const u of f.users)assert.equal(await userAbsent(u.localId),true);
 }
 // 2. Existing Auth UID collision aborts quarantine restore before creating any Auth user.
 {
  const f=await coordinatorFixture(t);
  const colliding=f.users.at(-1);
  await auth.createUser({uid:colliding.localId,email:'existing_'+colliding.email,password:'ExistingPass123!',disabled:false});
  const before=(await auth.getUser(colliding.localId)).toJSON();
  await assert.rejects(
   restoreRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{objects:100,batches:100}}),
   /existing-user-collision/,
  );
  assert.deepEqual((await auth.getUser(colliding.localId)).toJSON(),before);
  assert.equal(await userAbsent(f.users[0].localId),true);
 }
 // 3. Pre-existing live tenant or live operator record aborts activation preflight with zero live writes or Auth enablement.
 {
  const f=await coordinatorFixture(t);
  const restored=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
  assert.equal(restored.state,'verified_disabled_recovery');
  const liveTenantDoc=db.doc('tenants/'+f.context.tenantId);
  await liveTenantDoc.create({ownerUid:'someone_else',enabled:true});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-live-target-collision/,
  );
  assert.deepEqual((await liveTenantDoc.get()).data(),{ownerUid:'someone_else',enabled:true});
  assert.equal((await db.doc(f.operators[0].path).get()).exists,false);
  assert.equal((await db.doc('recoveryCoordinatorActivations/'+f.authorityContext.imageId).get()).exists,false);
  await verifyQuarantinedUsers(f);
  await liveTenantDoc.delete();

  await db.doc(f.operators[0].path).create({tenantId:f.context.tenantId,type:'preexisting'});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-live-operator-collision/,
  );
  assert.equal((await liveTenantDoc.get()).exists,false);
  assert.equal((await db.doc('recoveryCoordinatorActivations/'+f.authorityContext.imageId).get()).exists,false);
  await verifyQuarantinedUsers(f);
 }
});

test('interrupted execution and bounded budgets resume cleanly across quarantine and activation phases',async t=>{
 const f=await coordinatorFixture(t);
 // Quarantine bounded budgets: objects -> financial -> authority -> complete.
 const r1=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{objects:2}});
 assert.equal(r1.state,'staging');
 assert.equal(r1.phase,'objects');
 assert.equal((await db.doc('firestoreRecoveryQuarantine/'+f.authorityContext.imageId).get()).exists,false);

 const r2=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{batches:1}});
 assert.equal(r2.state,'staging');
 assert.equal(r2.phase,'financial');
 assert.equal(await userAbsent(f.users[0].localId),true);

 const r3=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{users:1}});
 assert.equal(r3.state,'staging');
 assert.equal(r3.phase,'authority');
 assert.equal(await userAbsent(f.users[0].localId),false);
 assert.equal(await userAbsent(f.users[1].localId),true);

 // Interruption inside afterPhase('authority') before final verification still resumes and completes.
 await assert.rejects(
  restoreRecoveryCoordinatorDemo({
   ...f.options,
   target:target(t),
   afterPhase:async event=>{if(event.phase==='authority')throw Error('synthetic-interrupt-after-authority');},
  }),
  /synthetic-interrupt-after-authority/,
 );
 const rFinal=await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
 assert.equal(rFinal.state,'verified_disabled_recovery');
 await verifyQuarantinedUsers(f);

 // Activation bounded budgets and interruption: activating_objects -> activating_financial -> activating_authority -> complete.
 const a1=await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{objects:2}});
 assert.equal(a1.state,'activating');
 assert.equal(a1.phase,'activating_objects');
 assert.equal((await db.doc('tenants/'+f.context.tenantId).get()).exists,false);

 const a2=await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{batches:1}});
 assert.equal(a2.state,'activating');
 assert.equal(a2.phase,'activating_financial');
 await verifyQuarantinedUsers(f);

 const a3=await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{users:1}});
 assert.equal(a3.state,'activating');
 assert.equal(a3.phase,'activating_authority');
 assert.equal((await auth.getUser(f.users[0].localId)).disabled,false);
 assert.equal((await auth.getUser(f.users[1].localId)).disabled,true);

 await assert.rejects(
  activateRecoveryCoordinatorDemo({
   ...f.options,
   target:target(t),
   afterPhase:async event=>{if(event.phase==='activating_authority')throw Error('synthetic-interrupt-after-activating-authority');},
  }),
  /synthetic-interrupt-after-activating-authority/,
 );
 const aFinal=await activateRecoveryCoordinatorDemo({...f.options,target:target(t)});
 assert.equal(aFinal.state,'activated_demo_recovery');
 await verifyActivatedUsers(f);
});

test('target tampering in object storage, quarantine Firestore, live Firestore, or Auth fails closed',async t=>{
 // 1. Tampering with a copied object in destinationDirectory before activation fails closed.
 {
  const f=await coordinatorFixture(t);
  await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
  const objectFile=join(f.destination.directory,createHash('sha256').update(f.pageKey).digest('hex')+'.object');
  await chmod(objectFile,0o600);
  await writeFile(objectFile,Buffer.from('corrupted-object-bytes'),{mode:0o600});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-object-integrity/,
  );
  assert.equal((await db.doc('tenants/'+f.context.tenantId).get()).exists,false);
 }
 // 2. Tampering with a quarantined financial record during partial activation fails closed on resume.
 {
  const f=await coordinatorFixture(t);
  await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
  const partial=await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{batches:1}});
  assert.equal(partial.phase,'activating_financial');
  const qEntry=db.doc('firestoreRecoveryQuarantine/'+f.authorityContext.imageId+'/tenants/'+f.context.tenantId+'/entries/paid_24');
  await qEntry.update({'payload.totalMinor':999999});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-quarantine-tampered/,
  );
 }
 // 3. Tampering with a committed live financial record or adding an extra live document fails closed.
 {
  const f=await coordinatorFixture(t);
  await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
  await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{batches:1}});
  await db.doc('tenants/'+f.context.tenantId+'/entries/accepted_sale').update({totalMinor:1});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-live-target-tampered/,
  );
  // Restore valid value, then add an unauthenticated extra document under live tenant.
  await db.doc('tenants/'+f.context.tenantId+'/entries/accepted_sale').update({totalMinor:7000});
  await db.doc('tenants/'+f.context.tenantId+'/entries/injected_extra').create({tenantId:f.context.tenantId,kind:'sale',totalMinor:500});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-live-target-tampered|recovery-coordinator-live-target-reconciliation/,
  );
 }
 // 4. Tampering with a quarantined Auth user (enabling out of band) before authority activation fails closed.
 {
  const f=await coordinatorFixture(t);
  await restoreRecoveryCoordinatorDemo({...f.options,target:target(t)});
  await activateRecoveryCoordinatorDemo({...f.options,target:target(t),budgets:{users:1}});
  await auth.updateUser(f.users[1].localId,{disabled:false});
  await assert.rejects(
   activateRecoveryCoordinatorDemo({...f.options,target:target(t)}),
   /recovery-coordinator-auth-tampered/,
  );
 }
});
