import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {assertRunnerEnvironment,assertPortsAvailable} from '../scripts/emulator-test-runner.mjs';
test('synthetic runner rejects live project and nonloopback/partial emulator environment',()=>{
 assert.doesNotThrow(()=>assertRunnerEnvironment({}));
 for(const env of [{GCLOUD_PROJECT:'live-project'},{GOOGLE_CLOUD_PROJECT:'live-project'},{FIRESTORE_EMULATOR_HOST:'db.example:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}])assert.throws(()=>assertRunnerEnvironment(env));
});
test('synthetic runner refuses an occupied local service instead of reusing it',async()=>{
 const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{await assert.rejects(assertPortsAvailable([server.address().port]),/port unavailable/);}finally{await new Promise(done=>server.close(done));}
});
