import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertDemoOperatorEnvironment,runDemoOperator,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';

const environment={FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};

test('demo operator admits both loopback emulator transports without production override',async()=>{
 for(const host of ['127.0.0.1','localhost','[::1]']){
  const env={FIRESTORE_EMULATOR_HOST:host+':8080',FIREBASE_AUTH_EMULATOR_HOST:host+':9099',GCLOUD_PROJECT:DEMO_PROJECT_ID};
  let calls=0;
  assert.equal(await runDemoOperator(DEMO_PROJECT_ID,()=>{calls++;return 'local';},env),'local');
  assert.equal(calls,1);
 }
});

test('mixed Auth/Firestore environments fail before any operator callback can initialize Admin or read/revoke a real user',async()=>{
 const rejected=[
  {},
  {FIRESTORE_EMULATOR_HOST:environment.FIRESTORE_EMULATOR_HOST},
  {FIREBASE_AUTH_EMULATOR_HOST:environment.FIREBASE_AUTH_EMULATOR_HOST},
  {...environment,FIREBASE_AUTH_EMULATOR_HOST:'identitytoolkit.googleapis.com:443'},
  {...environment,FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'},
  {...environment,FIREBASE_AUTH_EMULATOR_HOST:'192.168.1.10:9099'},
  {...environment,FIRESTORE_EMULATOR_HOST:'0.0.0.0:8080'},
  {...environment,GCLOUD_PROJECT:'actual-project'},
  {...environment,GOOGLE_CLOUD_PROJECT:'actual-project'},
  {...environment,ALLOW_PRODUCTION:'true',FIREBASE_AUTH_EMULATOR_HOST:undefined},
 ];
 for(const env of rejected){
  let adminCalls=0;
  await assert.rejects(runDemoOperator(DEMO_PROJECT_ID,()=>{adminCalls++;},env),/production operations are disabled/);
  assert.equal(adminCalls,0);
 }
 for(const projectId of ['actual-project','demo-other','',undefined]){
  let adminCalls=0;
  await assert.rejects(runDemoOperator(projectId,()=>{adminCalls++;},environment),/production operations are disabled/);
  assert.equal(adminCalls,0);
 }
});

test('loopback guards reject URLs, fake suffixes, user-info, paths and invalid ports',()=>{
 for(const value of ['http://127.0.0.1:8080','127.0.0.1.evil.test:8080','localhost.evil.test:9099','localhost:9099/','user@localhost:9099','localhost:0','localhost:65536','localhost:00080',' localhost:9099','localhost:9099\n','::1:9099','localhost']){
  for(const field of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST']){
   assert.throws(()=>assertDemoOperatorEnvironment(DEMO_PROJECT_ID,{...environment,[field]:value}),/production operations are disabled/);
  }
 }
});

test('actual provision and transfer CLIs reject mixed environments before opening the request or accessing Admin',()=>{
 const cwd=fileURLToPath(new URL('../',import.meta.url));
 for(const script of ['provision-tenant.mjs','transfer-device.mjs']){
  for(const overrides of [
   {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:''},
   {FIRESTORE_EMULATOR_HOST:'',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'},
   {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'identitytoolkit.googleapis.com:443'},
  ]){
   const result=spawnSync(process.execPath,['scripts/'+script,'/nonexistent/demo-request.json',DEMO_PROJECT_ID],{cwd,env:{...process.env,GCLOUD_PROJECT:DEMO_PROJECT_ID,GOOGLE_CLOUD_PROJECT:DEMO_PROJECT_ID,...overrides},encoding:'utf8',timeout:10000});
   assert.equal(result.status,1,result.stderr);
   assert.match(result.stderr,/both loopback Firestore\/Auth emulators/);
   assert.doesNotMatch(result.stderr,/ENOENT|Could not load the default credentials|credential-internal-error|ENOTFOUND/);
  }
 }
});
