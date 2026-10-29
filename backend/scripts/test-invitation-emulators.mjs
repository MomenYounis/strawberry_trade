// Entirely synthetic, serialized acceptance suite. Never reuses a live project,
// the normal emulator ports, or a developer's .secret.local file.
import {mkdtemp,writeFile,rm,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
for(const key of ['GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT'])if(process.env[key]&&process.env[key]!==DEMO_PROJECT_ID)throw Error('Synthetic emulator project required');
const backend=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(join(tmpdir(),'strawberry-invitation-emulators-'));
try{
 const functions=join(temporary,'functions'),config=join(temporary,'firebase.json');
 // A disposable source copy and private demo-only issuer keep this runner
 // independent of another Android test runner's in-memory trust keys.
 await cp(join(backend,'src'),join(functions,'src'),{recursive:true});
 await cp(join(backend,'package.json'),join(functions,'package.json'));
 await symlink(join(backend,'node_modules'),join(functions,'node_modules'),'dir');
 const issuer=generateKeyPairSync('ed25519');
 await writeFile(join(functions,'.secret.local'),'LICENSE_PRIVATE_KEY_PEM='+JSON.stringify(issuer.privateKey.export({format:'pem',type:'pkcs8'}))+'\n',{mode:0o600});
 await writeFile(config,JSON.stringify({functions:[{source:'functions',codebase:'tenant-gateway',runtime:'nodejs22',ignore:['test','worker','node_modules','*-debug.log','.secret.local']}],firestore:{rules:join(backend,'firestore.rules'),indexes:join(backend,'firestore.indexes.json')},emulators:{auth:{host:'127.0.0.1',port:19199},functions:{host:'127.0.0.1',port:15101},firestore:{host:'127.0.0.1',port:18180,websocketPort:9173},hub:{host:'127.0.0.1',port:4417},logging:{host:'127.0.0.1',port:4517},eventarc:{host:'127.0.0.1',port:19299},tasks:{host:'127.0.0.1',port:19499},ui:{enabled:false},singleProjectMode:true}}));
 const child=spawn(join(backend,'node_modules/.bin/firebase'),['emulators:exec','--config',config,'--project',DEMO_PROJECT_ID,'--only','auth,firestore,functions','node --test --test-concurrency=1 test/integration.test.mjs test/shipment.test.mjs test/invitation-signup.integration.test.mjs'],{cwd:backend,env:{...process.env,GCLOUD_PROJECT:DEMO_PROJECT_ID,STRAWBERRY_TEST_FUNCTIONS_PORT:'15101',JAVA_TOOL_OPTIONS:process.env.JAVA_TOOL_OPTIONS||'-Xmx512m'},stdio:'inherit'});
 const forward=()=>child.kill('SIGTERM');process.once('SIGINT',forward);process.once('SIGTERM',forward);
 process.exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});
 process.removeListener('SIGINT',forward);process.removeListener('SIGTERM',forward);
}finally{await rm(temporary,{recursive:true,force:true});}
