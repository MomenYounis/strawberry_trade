// Owned loopback-only Worker + Auth/Firestore integration environment.
// No cloud configuration, credentials or repository .dev.vars are consumed.
import {spawn} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {DEMO_PROJECT_ID,assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';

const backend=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const inside=process.argv.includes('--inside'),serve=process.argv.includes('--serve');
const native=process.argv.includes('--native');
export const HTTP_TEST_PORTS=Object.freeze({auth:19099,firestore:18080,worker:8788,websocket:9188,hub:4418,logging:4518,inspector:9239});
const ports=native?{...HTTP_TEST_PORTS,auth:9099,firestore:8080}:HTTP_TEST_PORTS;
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function available(){
 const servers=[];
 try{for(const port of Object.values(ports)){const server=createServer();await new Promise((done,reject)=>{server.once('error',()=>reject(Error('Synthetic test port unavailable: '+port)));server.listen({host:'127.0.0.1',port,exclusive:true},done);});servers.push(server);}}
 finally{await Promise.all(servers.map(server=>new Promise(done=>server.close(done))));}
}
function stop(child,signal='SIGTERM'){if(child?.pid)try{process.kill(-child.pid,signal);}catch{}}
async function exited(child){return new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});}
if(inside){
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
 if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:'+ports.firestore||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:'+ports.auth)throw Error('Unexpected emulator ports');
 const worker=join(backend,'worker');
 const child=spawn(join(worker,'node_modules/.bin/wrangler'),['dev','--config',join(worker,'wrangler.jsonc'),'--env','emulator','--local','--ip','127.0.0.1','--port',String(ports.worker),'--inspector-port',String(ports.inspector),'--persist-to',join(backend,'worker-state')],{cwd:worker,stdio:'inherit',env:{...process.env,CLOUDFLARE_SEND_METRICS:'false',WRANGLER_SEND_METRICS:'false'},detached:true});
 const terminate=()=>stop(child);
 process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
 try{
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
   if(child.exitCode!==null)throw Error('Owned local workerd exited');
   try{const result=await fetch('http://127.0.0.1:'+ports.worker+'/health',{signal:AbortSignal.timeout(1000)});const body=await result.json();if(result.ok&&body.protocol==='strawberry-gateway-v1'){ready=true;break;}}catch{}
   await pause(500);
  }
  if(!ready)throw Error('Owned local workerd not ready');
  if(serve){
   console.log(JSON.stringify({state:'ready',synthetic:true,projectId:DEMO_PROJECT_ID,pid:process.pid,runtimeRoot:dirname(backend),ports}));
   await new Promise(done=>{process.once('SIGTERM',done);process.once('SIGINT',done);child.once('exit',done);});
  }else{
   const test=spawn(process.execPath,['test/http-emulator.mjs'],{cwd:worker,stdio:'inherit',env:{...process.env,STRAWBERRY_HTTP_TEST_RESULTS:process.env.STRAWBERRY_HTTP_TEST_RESULTS}});
   process.exitCode=await exited(test);
  }
 }finally{stop(child);await pause(500);if(child.exitCode===null)stop(child,'SIGKILL');process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);}
}else{
 for(const key of ['GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT'])if(process.env[key]&&process.env[key]!==DEMO_PROJECT_ID)throw Error('Synthetic project required');
 if(process.env.FIRESTORE_EMULATOR_HOST||process.env.FIREBASE_AUTH_EMULATOR_HOST)assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
 await available();
 const retained=process.env.STRAWBERRY_NATIVE_RUNTIME_ROOT;
 if(retained&&(!serve||!native||!/^\/home\/younis\/\.local\/share\/strawberry-trade-test-runtime\/backend-[a-z0-9_-]+$/.test(retained)))throw Error('owned-retained-native-runtime-required');
 if(retained){await mkdir(retained,{recursive:true,mode:0o700});const permissions=await stat(retained);if(!permissions.isDirectory()||(permissions.mode&0o077)!==0)throw Error('private-native-runtime-required');}
 const temporary=retained??await mkdtemp(join(tmpdir(),'strawberry-worker-http-')),copy=join(temporary,'backend');
 let child;
 try{
  await mkdir(join(copy,'worker','test'),{recursive:true});await mkdir(join(copy,'scripts'),{recursive:true});
  await cp(join(backend,'src'),join(copy,'src'),{recursive:true});
  for(const name of ['firestore.rules','firestore.indexes.json'])await cp(join(backend,name),join(copy,name));
  for(const name of ['index.mjs','runtime.mjs','runtime-config.mjs','compatibility.mjs','private-stream-debug.mjs','emulator-firestore-auth.mjs','request-forward.mjs'])await cp(join(backend,'worker',name),join(copy,'worker',name));
  await cp(join(backend,'worker/test/http-emulator.mjs'),join(copy,'worker/test/http-emulator.mjs'));
  await cp(fileURLToPath(import.meta.url),join(copy,'scripts/worker-http-test-runner.mjs'));
  try{await symlink(join(backend,'node_modules'),join(copy,'node_modules'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
  try{await symlink(join(backend,'worker/node_modules'),join(copy,'worker/node_modules'),'dir');}catch(e){if(e.code!=='EEXIST')throw e;}
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),issuer=generateKeyPairSync('ed25519');
  const account={type:'service_account',project_id:DEMO_PROJECT_ID,client_email:'synthetic-worker@'+DEMO_PROJECT_ID+'.iam.gserviceaccount.com',private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  const fixtures={FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(account),LICENSE_PRIVATE_KEY_PEM:issuer.privateKey.export({type:'pkcs8',format:'pem'}).toString(),LICENSE_PUBLIC_KEY_PEM:issuer.publicKey.export({type:'spki',format:'pem'}).toString()};
  let existingFixtures=null;try{existingFixtures=await readFile(join(copy,'worker/.dev.vars.emulator'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existingFixtures!==null){if(!retained||!existingFixtures.startsWith('# Synthetic loopback fixtures. These are not Google credentials.'))throw Error('synthetic-retained-issuer-required');}
  else {await writeFile(join(copy,'worker/.dev.vars.emulator'),'# Synthetic loopback fixtures. These are not Google credentials.\n'+Object.entries(fixtures).map(([key,value])=>key+'='+(key==='FIREBASE_SERVICE_ACCOUNT_JSON'?"'"+value+"'":JSON.stringify(value))).join('\n')+'\n',{mode:0o600,flag:'wx'});}

  const vars={WORKER_EMULATOR_ONLY:'true',FIREBASE_PROJECT_ID:DEMO_PROJECT_ID,FIREBASE_ANDROID_APP_ID:'1:123456789:android:1234567890abcdef',FIRESTORE_EMULATOR_HOST:'127.0.0.1:'+ports.firestore,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:'+ports.auth,LICENSE_KEY_ID:'worker-emulator-only'};
  await writeFile(join(copy,'worker/wrangler.jsonc'),JSON.stringify({name:'strawberry-owned-local-worker',main:'index.mjs',compatibility_date:'2026-10-19',compatibility_flags:['nodejs_compat'],define:{__dirname:'"/"'},workers_dev:false,upload_source_maps:false,durable_objects:{bindings:[{name:'GATEWAY',class_name:'TradingGateway'}]},migrations:[{tag:'v1',new_sqlite_classes:['TradingGateway']}],env:{emulator:{name:'strawberry-owned-local-worker',define:{__dirname:'"/"'},vars,durable_objects:{bindings:[{name:'GATEWAY',class_name:'TradingGateway'}]}}}}));
  const local=port=>({host:'127.0.0.1',port});
  await writeFile(join(temporary,'firebase.json'),JSON.stringify({firestore:{rules:join(copy,'firestore.rules'),indexes:join(copy,'firestore.indexes.json')},emulators:{auth:local(ports.auth),firestore:{...local(ports.firestore),websocketPort:ports.websocket},hub:local(ports.hub),logging:local(ports.logging),ui:{enabled:false},singleProjectMode:true}}));
  // The inherited home is only for emulator binary cache; credential/token/env
  // paths and config store are isolated. No cloud token or ADC variable passes.
  const env=Object.fromEntries(['PATH','HOME','JAVA_HOME','LANG','LC_ALL','TMPDIR','SYSTEMROOT'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  Object.assign(env,{XDG_CONFIG_HOME:join(temporary,'config'),GCLOUD_PROJECT:DEMO_PROJECT_ID,GOOGLE_CLOUD_PROJECT:DEMO_PROJECT_ID,CI:'true',JAVA_TOOL_OPTIONS:'-Xmx512m',CLOUDFLARE_SEND_METRICS:'false',WRANGLER_SEND_METRICS:'false',NO_COLOR:'1'});
  if(process.env.STRAWBERRY_HTTP_TEST_RESULTS)env.STRAWBERRY_HTTP_TEST_RESULTS=resolve(process.env.STRAWBERRY_HTTP_TEST_RESULTS);
  const command='node '+join(copy,'scripts/worker-http-test-runner.mjs')+' --inside'+(serve?' --serve':'')+(native?' --native':'');
  const persistence=[];
  if(retained){const exported=join(temporary,'emulator-export');persistence.push('--export-on-exit',exported);let imported=exported;
   try{const latest=JSON.parse(await readFile(join(temporary,'latest-checkpoint.json'),'utf8'));if(latest.projectId!==DEMO_PROJECT_ID||!/^checkpoint-[a-z][a-z0-9-]{0,35}$/.test(latest.directory))throw Error('invalid-native-checkpoint');imported=join(temporary,latest.directory);}catch(e){if(e.code!=='ENOENT')throw e;}
   try{await stat(join(imported,'firebase-export-metadata.json'));persistence.push('--import',imported);}catch(e){if(e.code!=='ENOENT')throw e;}}
  child=spawn(join(backend,'node_modules/.bin/firebase'),['emulators:exec','--non-interactive','--config',join(temporary,'firebase.json'),'--project',DEMO_PROJECT_ID,'--only','auth,firestore',...persistence,command],{cwd:copy,env,stdio:'inherit',detached:true});
  const terminate=()=>stop(child),timeout=setTimeout(terminate,serve?90*60000:5*60000);
  process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  try{process.exitCode=await exited(child);}finally{clearTimeout(timeout);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);}
 }finally{stop(child);await pause(500);if(child?.exitCode===null)stop(child,'SIGKILL');if(!retained)await rm(temporary,{recursive:true,force:true});}
}
