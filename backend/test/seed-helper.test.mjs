import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticFixtureIds,validateSeedEnvironment} from '../scripts/seed-helper.mjs';

const namespace='0123456789abcdef01234567';
const environment={GCLOUD_PROJECT:'demo-strawberry-flutter',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',TEST_FIXTURE_NAMESPACE:namespace};

test('fresh wrapper namespace allocates a different tenant while preserving identity and same-session stability',()=>{
 const old=syntheticFixtureIds('device_A',namespace),same=syntheticFixtureIds('device_A',namespace),fresh=syntheticFixtureIds('device_A','fedcba9876543210fedcba98'),other=syntheticFixtureIds('device_B',namespace);
 assert.deepEqual(old,same);
 assert.notEqual(old.tenantId,fresh.tenantId);
 assert.equal(old.uid,fresh.uid);
 assert.equal(old.email,fresh.email);
 assert.notEqual(old.tenantId,other.tenantId);
 assert.match(old.tenantId,/^[A-Za-z0-9_-]{1,120}$/);
 assert.match(old.email,/@example\.test$/);
});

test('helper refuses missing or malformed namespace before accessing emulators',()=>{
 assert.equal(validateSeedEnvironment(environment),namespace);
 for(const value of [undefined,'','short','ABCDEF0123456789ABCDEF01','../0123456789abcdef012345','0123456789abcdef01234567/child',12]){
  assert.throws(()=>validateSeedEnvironment({...environment,TEST_FIXTURE_NAMESPACE:value}),/fixture namespace/);
  assert.throws(()=>syntheticFixtureIds('device_A',value),/fixture namespace/);
 }
 assert.throws(()=>syntheticFixtureIds('../device',namespace));
});

test('helper refuses production project, public bind hosts and non-loopback emulator endpoints',()=>{
 for(const overrides of [
  {GCLOUD_PROJECT:'actual-project'},
  {FIRESTORE_EMULATOR_HOST:'0.0.0.0:8080'},
  {FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'},
  {FIREBASE_AUTH_EMULATOR_HOST:'192.168.1.10:9099'},
  {FIREBASE_AUTH_EMULATOR_HOST:undefined},
 ])assert.throws(()=>validateSeedEnvironment({...environment,...overrides}),/Local demo emulators required/);
});
