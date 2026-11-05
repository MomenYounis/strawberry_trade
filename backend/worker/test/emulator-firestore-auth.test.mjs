import test from 'node:test';
import assert from 'node:assert/strict';
import {emulatorFirestoreSettings} from '../emulator-firestore-auth.mjs';
const environment={GCLOUD_PROJECT:'demo-strawberry-flutter',FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19099'};
test('owner REST credential is scoped to the guarded demo environment',async()=>{
 const settings=emulatorFirestoreSettings('demo-strawberry-flutter',environment);
 assert.deepEqual(Object.keys(settings),['authClient']);
 assert.equal((await settings.authClient.getRequestHeaders()).get('authorization'),'Bearer owner');
 assert.equal(settings.authClient.credentials.refresh_token,undefined);
});
test('owner REST credential cannot be constructed for a live project or remote service',()=>{
 for(const [projectId,env] of [
  ['strawberry-trade-261017-6a49b',environment],
  ['demo-strawberry-flutter',{...environment,FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'}],
  ['demo-strawberry-flutter',{...environment,FIREBASE_AUTH_EMULATOR_HOST:undefined}],
  ['demo-strawberry-flutter',{...environment,GOOGLE_CLOUD_PROJECT:'live-project'}],
 ])assert.throws(()=>emulatorFirestoreSettings(projectId,env),/Local demo operators require/);
});
