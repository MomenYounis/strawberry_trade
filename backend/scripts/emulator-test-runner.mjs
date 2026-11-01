// Synthetic-only integration harness. No repository secrets or occupied services.
import {mkdtemp,writeFile,rm,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {DEMO_PROJECT_ID,assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';
const backend=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const TEST_PORTS=Object.freeze({auth:19199,functions:15101,firestore:18180,websocket:9173,hub:4417,logging:4517,eventarc:19299,tasks:19499});
export function assertRunnerEnvironment(env){
 for(const key of ['GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT'])if(env[key]&&env[key]!==DEMO_PROJECT_ID)throw Error('Synthetic emulator project required');
 if(env.FIRESTORE_EMULATOR_HOST||env.FIREBASE_AUTH_EMULATOR_HOST)assertDemoOperatorEnvironment(DEMO_PROJECT_ID,env);
}
export async function assertPortsAvailable(ports=Object.values(TEST_PORTS)){
 const reservations=[];
 try{for(const port of ports){const server=createServer();await new Promise((done,reject)=>{server.once('error',()=>reject(Error('Synthetic test port unavailable: '+port)));server.listen({host:'127.0.0.1',port,exclusive:true},done);});reservations.push(server);}}
 finally{await Promise.all(reservations.map(server=>new Promise(done=>server.close(done))));}
}
export async function runEmulatorTests(files){
 assertRunnerEnvironment(process.env);
 if(!files.length||files.some(file=>!/^test\/[a-z-]+(?:\.integration)?\.test\.mjs$/.test(file)))throw Error('Invalid synthetic test selection');
 await assertPortsAvailable();
 const temporary=await mkdtemp(join(tmpdir(),'strawberry-synthetic-emulators-'));
 try{
  const functions=join(temporary,'functions'),config=join(temporary,'firebase.json');
  await cp(join(backend,'src'),join(functions,'src'),{recursive:true});
  await cp(join(backend,'package.json'),join(functions,'package.json'));
  await symlink(join(backend,'node_modules'),join(functions,'node_modules'),'dir');
  const issuer=generateKeyPairSync('ed25519'),pem=issuer.privateKey.export({format:'pem',type:'pkcs8'});
  await writeFile(join(functions,'.secret.local'),'LICENSE_PRIVATE_KEY_PEM='+JSON.stringify(pem)+'\n',{mode:0o600,flag:'wx'});
  const emulator=(port)=>({host:'127.0.0.1',port});
  await writeFile(config,JSON.stringify({functions:[{source:'functions',codebase:'tenant-gateway',runtime:'nodejs22',ignore:['test','worker','node_modules','*-debug.log','.secret.local']}],firestore:{rules:join(backend,'firestore.rules'),indexes:join(backend,'firestore.indexes.json')},emulators:{auth:emulator(TEST_PORTS.auth),functions:emulator(TEST_PORTS.functions),firestore:{...emulator(TEST_PORTS.firestore),websocketPort:TEST_PORTS.websocket},hub:emulator(TEST_PORTS.hub),logging:emulator(TEST_PORTS.logging),eventarc:emulator(TEST_PORTS.eventarc),tasks:emulator(TEST_PORTS.tasks),ui:{enabled:false},singleProjectMode:true}}));
  // Intentionally do not pass credential, live endpoint, token, or issuer env.
  const env=Object.fromEntries(['PATH','HOME','JAVA_HOME','LANG','LC_ALL','TMPDIR','SYSTEMROOT'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  Object.assign(env,{XDG_CONFIG_HOME:join(temporary,'config'),GCLOUD_PROJECT:DEMO_PROJECT_ID,GOOGLE_CLOUD_PROJECT:DEMO_PROJECT_ID,CI:'true',JAVA_TOOL_OPTIONS:'-Xmx512m',STRAWBERRY_TEST_FUNCTIONS_PORT:String(TEST_PORTS.functions),LICENSE_PRIVATE_KEY_PEM:pem,LICENSE_PUBLIC_KEY_PEM:issuer.publicKey.export({format:'pem',type:'spki'}),LICENSE_KEY_ID:'emulator-session-only'});
  const child=spawn(join(backend,'node_modules/.bin/firebase'),['emulators:exec','--non-interactive','--config',config,'--project',DEMO_PROJECT_ID,'--only','auth,firestore,functions','node --test --test-concurrency=1 '+files.join(' ')],{cwd:backend,env,stdio:'inherit',detached:process.platform!=='win32'});
  const terminate=()=>{try{if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}catch{}};
  const timeout=setTimeout(terminate,240000);
  process.once('SIGINT',terminate);process.once('SIGTERM',terminate);
  try{return await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});}
  finally{clearTimeout(timeout);process.removeListener('SIGINT',terminate);process.removeListener('SIGTERM',terminate);}
 }finally{await rm(temporary,{recursive:true,force:true});}
}
