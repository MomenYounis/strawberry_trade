import {createHash,createPrivateKey,createPublicKey,timingSafeEqual} from 'node:crypto';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';

const required = ['FIREBASE_PROJECT_ID','FIREBASE_ANDROID_APP_ID','FIREBASE_SERVICE_ACCOUNT_JSON',
  'LICENSE_PRIVATE_KEY_PEM','LICENSE_PUBLIC_KEY_PEM','LICENSE_KEY_ID'];
const emulatorKeys = ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'];
export class WorkerConfigurationError extends Error {
  constructor(stage='configuration') {super('worker_configuration_invalid');this.name='WorkerConfigurationError';this.code='worker-config/'+stage;}
}
function invalid() {throw new WorkerConfigurationError();}

/** Validate secrets in memory. Never include binding contents in errors/logs. */
export function validateWorkerBindings(env) {
  let stage='bindings';
  try {
    for (const key of required) {
      if (typeof env[key] !== 'string' || !env[key].trim() || Buffer.byteLength(env[key]) > 5120) invalid();
    }
    const projectId=env.FIREBASE_PROJECT_ID,appId=env.FIREBASE_ANDROID_APP_ID;
    stage='identity';
    const emulator=env.WORKER_EMULATOR_ONLY === 'true';
    if (env.WORKER_EMULATOR_ONLY !== undefined && !emulator) invalid();
    if (!/^1:[0-9]+:android:[a-f0-9]+$/.test(appId) ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(env.LICENSE_KEY_ID)) invalid();
    if (emulator) {
      assertDemoOperatorEnvironment(projectId,{...env,GCLOUD_PROJECT:projectId});
    } else if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
        projectId.startsWith('demo-') || env.LICENSE_KEY_ID === 'local-test-v1' ||
        emulatorKeys.some(key => env[key] !== undefined)) invalid();
    stage='service-account';
    const serviceAccount=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!serviceAccount || Array.isArray(serviceAccount) || serviceAccount.type !== 'service_account' ||
        serviceAccount.project_id !== projectId ||
        typeof serviceAccount.client_email !== 'string' ||
        !/^[A-Za-z0-9._-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount.client_email) ||
        typeof serviceAccount.private_key !== 'string') invalid();
    stage='service-account-key';
    const accountKey=createPrivateKey(serviceAccount.private_key);
    if (accountKey.asymmetricKeyType !== 'rsa' || accountKey.asymmetricKeyDetails.modulusLength < 2048) invalid();
    stage='issuer-key';
    const privateKey=createPrivateKey(env.LICENSE_PRIVATE_KEY_PEM),publicKey=createPublicKey(env.LICENSE_PUBLIC_KEY_PEM);
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') invalid();
    stage='issuer-pair';
    const derived=createPublicKey(privateKey).export({format:'der',type:'spki'});
    const configured=publicKey.export({format:'der',type:'spki'});
    if (derived.length !== configured.length || !timingSafeEqual(derived,configured)) invalid();
    const fingerprint=createHash('sha256').update(JSON.stringify([...required,...emulatorKeys,'WORKER_EMULATOR_ONLY'].map(key=>[key,env[key]??null]))).digest('hex');
    return {projectId,appId,emulator,serviceAccount,privateKeyPem:env.LICENSE_PRIVATE_KEY_PEM,
      publicKeyPem:env.LICENSE_PUBLIC_KEY_PEM,kid:env.LICENSE_KEY_ID,fingerprint,
      firestoreEmulator:env.FIRESTORE_EMULATOR_HOST,authEmulator:env.FIREBASE_AUTH_EMULATOR_HOST};
  } catch {throw new WorkerConfigurationError(stage);}
}

export function workerBindingFingerprint(env) {
  // The hash is internal cache identity, never a logged diagnostic.
  return createHash('sha256').update(JSON.stringify([...required,...emulatorKeys,'WORKER_EMULATOR_ONLY']
    .map(key=>[key,typeof env[key]==='string'?env[key]:null]))).digest('hex');
}
