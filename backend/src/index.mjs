import {initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {defineSecret} from 'firebase-functions/params';
import {createGateway} from './gateway.mjs';
import {acceptInvitation as accept} from './enrollment.mjs';
import {GatewayError} from './validation.mjs';
initializeApp();
const issuerPrivate=defineSecret('LICENSE_PRIVATE_KEY_PEM');
const gateway=createGateway({db:getFirestore(),auth:getAuth(),privateKey:()=>issuerPrivate.value()});
const options={region:'europe-west1',maxInstances:3,concurrency:20,memory:'256MiB',timeoutSeconds:60,secrets:[issuerPrivate],enforceAppCheck:process.env.FUNCTIONS_EMULATOR!=='true'};
const callable=name=>onCall(options,async request=>{
 try{return await gateway[name](request);}catch(e){
  if(e instanceof GatewayError){const supported=['unauthenticated','permission-denied','invalid-argument','resource-exhausted'];throw new HttpsError(supported.includes(e.code)?e.code:'failed-precondition',e.code,{reason:e.code});}
  // Do not log payloads, activation packages, tokens or financial records.
  console.error('gateway-failure',{endpoint:name,errorType:e?.name||'unknown'});throw new HttpsError('internal','server-error');
 }
});
export const bootstrap=callable('bootstrap');
export const syncOperation=callable('syncOperation');
export const pullChanges=callable('pullChanges');
export const activateLicense=callable('activateLicense');
export const setMemberActive=callable('setMemberActive');

export const acceptInvitation=onCall(options,async request=>{try{return await accept({db:getFirestore(),auth:getAuth(),request});}catch(e){throw new HttpsError('failed-precondition',e instanceof GatewayError?e.code:'enrollment-failed');}});

export const createEmployeeInvitation=callable('createEmployeeInvitation');
