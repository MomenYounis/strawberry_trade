import {initializeApp,getApps,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {getAppCheck} from 'firebase-admin/app-check';
import {createGateway} from '../src/gateway.mjs';
import {acceptInvitation} from '../src/enrollment.mjs';
import {createHttpGateway} from '../src/http-gateway.mjs';
import {validateWorkerBindings,workerBindingFingerprint,WorkerConfigurationError} from './runtime-config.mjs';

const runtimes=new Map();
export function workerRuntime(env) {
  const fingerprint=workerBindingFingerprint(env);
  if (runtimes.has(fingerprint)) return runtimes.get(fingerprint);
  const config=validateWorkerBindings(env);
  if (runtimes.size >= 4) throw new WorkerConfigurationError();
  if (config.emulator) {
    process.env.GCLOUD_PROJECT=config.projectId;
    process.env.FIRESTORE_EMULATOR_HOST=config.firestoreEmulator;
    process.env.FIREBASE_AUTH_EMULATOR_HOST=config.authEmulator;
  } else if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new WorkerConfigurationError();
  }
  const name='strawberry-worker-'+fingerprint.slice(0,24);
  const app=getApps().find(item=>item.name===name)||initializeApp({projectId:config.projectId,credential:cert(config.serviceAccount)},name);
  if (app.options.projectId !== config.projectId) throw new WorkerConfigurationError();
  const db=initializeFirestore(app,{preferRest:true}),auth=getAuth(app);
  const gateway=createGateway({db,auth,privateKey:()=>config.privateKeyPem,
    publicKey:()=>config.publicKeyPem,kid:()=>config.kid});
  gateway.acceptInvitation=request=>acceptInvitation({db,auth,request});
  const fetch=createHttpGateway({gateway,auth,appCheck:getAppCheck(app),expectedAppId:config.appId,
    projectId:config.projectId,emulator:config.emulator,emulatorEnvironment:{
      GCLOUD_PROJECT:config.projectId,FIRESTORE_EMULATOR_HOST:config.firestoreEmulator,
      FIREBASE_AUTH_EMULATOR_HOST:config.authEmulator},logFailure:()=>{}});
  const runtime={fetch};
  runtimes.set(fingerprint,runtime);
  return runtime;
}
