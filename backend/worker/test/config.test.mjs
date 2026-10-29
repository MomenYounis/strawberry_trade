import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {validateWorkerBindings,WorkerConfigurationError} from '../runtime-config.mjs';

const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),issuer=generateKeyPairSync('ed25519');
const project='strawberry-worker-test';
function bindings(projectId=project) {
 return {FIREBASE_PROJECT_ID:projectId,FIREBASE_ANDROID_APP_ID:'1:123456789:android:1234567890abcdef',
  FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:projectId,
   client_email:'synthetic-worker@'+projectId+'.iam.gserviceaccount.com',
   private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()}),
  LICENSE_PRIVATE_KEY_PEM:issuer.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  LICENSE_PUBLIC_KEY_PEM:issuer.publicKey.export({type:'spki',format:'pem'}).toString(),LICENSE_KEY_ID:'issuer-v1'};
}
function rejected(env) {
 assert.throws(()=>validateWorkerBindings(env),error=>error instanceof WorkerConfigurationError &&
  error.message==='worker_configuration_invalid' && !error.message.includes('PRIVATE KEY'));
}

test('valid matching production bindings are checked locally without credential requests',()=>{
 const configured=validateWorkerBindings(bindings());
 assert.equal(configured.projectId,project);assert.equal(configured.emulator,false);
 assert.equal(configured.kid,'issuer-v1');assert.match(configured.fingerprint,/^[a-f0-9]{64}$/);
});

test('wrong-project service account, wrong APK registration and mismatched issuer keys fail closed',()=>{
 const base=bindings(),otherIssuer=generateKeyPairSync('ed25519');
 rejected({...base,FIREBASE_SERVICE_ACCOUNT_JSON:bindings('other-approved-project').FIREBASE_SERVICE_ACCOUNT_JSON});
 rejected({...base,FIREBASE_ANDROID_APP_ID:'1:123:web:legacy'});
 rejected({...base,LICENSE_PUBLIC_KEY_PEM:otherIssuer.publicKey.export({type:'spki',format:'pem'}).toString()});
 rejected({...base,LICENSE_PUBLIC_KEY_PEM:rsa.publicKey.export({type:'spki',format:'pem'}).toString()});
 rejected({...base,LICENSE_PRIVATE_KEY_PEM:'-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----'});
 rejected({...base,FIREBASE_SERVICE_ACCOUNT_JSON:'not JSON'});
 rejected({...base,LICENSE_KEY_ID:'local-test-v1'});
});

test('missing or oversized secret binding is rejected before SDK initialization',()=>{
 for(const key of ['FIREBASE_PROJECT_ID','FIREBASE_ANDROID_APP_ID','FIREBASE_SERVICE_ACCOUNT_JSON',
  'LICENSE_PRIVATE_KEY_PEM','LICENSE_PUBLIC_KEY_PEM','LICENSE_KEY_ID']){
  rejected({...bindings(),[key]:undefined});rejected({...bindings(),[key]:'ع'.repeat(3000)});
 }
});

test('emulator exemption requires the exact demo project and both loopback services',()=>{
 const valid={...bindings('demo-strawberry-flutter'),WORKER_EMULATOR_ONLY:'true',
  FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19099'};
 assert.equal(validateWorkerBindings(valid).emulator,true);
 rejected({...valid,FIREBASE_PROJECT_ID:'demo-other'});
 rejected({...valid,FIREBASE_PROJECT_ID:project});
 rejected({...valid,FIREBASE_AUTH_EMULATOR_HOST:undefined});
 rejected({...valid,FIRESTORE_EMULATOR_HOST:'firestore.googleapis.com:443'});
 rejected({...valid,FIREBASE_AUTH_EMULATOR_HOST:'192.168.1.1:9099'});
 rejected({...bindings(),FIRESTORE_EMULATOR_HOST:'127.0.0.1:18080'});
 rejected({...bindings(),WORKER_EMULATOR_ONLY:'false'});
});
