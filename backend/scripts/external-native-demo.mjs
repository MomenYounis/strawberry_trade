// Demo-only native transport fixture. Never deploy or expose this runner.
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {generateKeyPairSync, randomBytes, createHash, sign} from 'node:crypto';
import {writeFile, unlink, mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertDemoOperatorEnvironment, DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {createGateway} from '../src/gateway.mjs';
import {acceptInvitation, provisionTenant} from '../src/enrollment.mjs';
import {createHttpGateway} from '../src/http-gateway.mjs';
import {startSeedHelper} from './seed-helper.mjs';
import {initializeApp, getApps} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(backend, '..');
const evidenceDir = resolve(project, '../../work/no-card-native');
for (const name of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
  if (process.env[name] && process.env[name] !== DEMO_PROJECT_ID) throw Error('Refusing inherited non-demo project');
}
Object.assign(process.env, {
  GCLOUD_PROJECT: DEMO_PROJECT_ID,
  GOOGLE_CLOUD_PROJECT: DEMO_PROJECT_ID,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  TEST_FIXTURE_NAMESPACE: randomBytes(12).toString('hex'),
});
assertDemoOperatorEnvironment(DEMO_PROJECT_ID);
await mkdir(evidenceDir, {recursive:true});
async function listening(port) {
  return new Promise(resolveResult => {
    const socket = createConnection({port, host:'127.0.0.1'});
    socket.once('connect',()=>{socket.destroy();resolveResult(true);});
    socket.once('error',()=>resolveResult(false));
  });
}
for (const port of [9099,8080,5001,8008,18787,4412,4512,9152]) {
  if (await listening(port)) throw Error('Native demo port already in use: '+port);
}
const pair=generateKeyPairSync('ed25519');
const privatePem=pair.privateKey.export({type:'pkcs8',format:'pem'});
const publicPem=pair.publicKey.export({type:'spki',format:'pem'});
const kid='external-native-demo-only';
const publicKeys={[kid]:pair.publicKey.export({format:'jwk'}).x};
Object.assign(process.env,{LICENSE_PRIVATE_KEY_PEM:privatePem,LICENSE_PUBLIC_KEY_PEM:publicPem,LICENSE_KEY_ID:kid});
const secretPath=resolve(backend,'.secret.local');
await writeFile(secretPath,'LICENSE_PRIVATE_KEY_PEM='+JSON.stringify(privatePem)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(evidenceDir,'defines.json'),JSON.stringify({
  USE_EMULATORS:'true',EMULATOR_HOST:'10.0.2.2',
  LICENSE_PUBLIC_KEYS:JSON.stringify(publicKeys),GATEWAY_BASE_URL:'http://10.0.2.2:18787',
},null,2)+'\n');
const configPath=resolve(evidenceDir,'firebase.json');
await writeFile(configPath,JSON.stringify({
  functions:[{source:relative(dirname(configPath),backend),codebase:'tenant-gateway',runtime:'nodejs22',ignore:['test','worker','node_modules','*-debug.log','.secret.local']}],
  firestore:{rules:resolve(backend,'firestore.rules'),indexes:resolve(backend,'firestore.indexes.json')},
  emulators:{auth:{host:'127.0.0.1',port:9099},firestore:{host:'127.0.0.1',port:8080,websocketPort:9152},
    functions:{host:'127.0.0.1',port:5001},hub:{host:'127.0.0.1',port:4412},logging:{host:'127.0.0.1',port:4512},ui:{enabled:false},singleProjectMode:true},
},null,2));

// The guard above runs before any Admin initialization or seed operation.
const app=getApps().find(a=>a.name==='[DEFAULT]')||initializeApp({projectId:DEMO_PROJECT_ID});
if(app.options.projectId!==DEMO_PROJECT_ID)throw Error('Demo default app mismatch');
const auth=getAuth(app),db=getFirestore(app);
const gateway=createGateway({db,auth});
gateway.acceptInvitation=request=>acceptInvitation({db,auth,request});
const metrics={projectId:DEMO_PROJECT_ID,externalPort:18787,verifiedAuthHeaders:0,requests:{},taggedLargeInteger:false,decodedLargeInteger:false,largeIntegerWireRequests:0,largeIntegerWireKinds:[]};
const checkedAuth={verifyIdToken:async(token,revoked)=>{
  const decoded=await auth.verifyIdToken(token,revoked);
  metrics.verifiedAuthHeaders++;
  return decoded;
}};
const wrapped=Object.fromEntries(Object.entries(gateway).map(([name,method])=>[name,async request=>{
  metrics.requests[name]=(metrics.requests[name]||0)+1;
  if(request.data?.operation?.payload?.totalMinor===3000000000)metrics.decodedLargeInteger=true;
  return method(request);
}]));
const handler=createHttpGateway({gateway:wrapped,auth:checkedAuth,projectId:DEMO_PROJECT_ID,emulator:true,emulatorEnvironment:process.env});
async function employeeFixture() {
  assertDemoOperatorEnvironment(DEMO_PROJECT_ID);
  const suffix=randomBytes(10).toString('hex'),uid='native_manager_'+suffix,tenantId='native_staff_'+suffix;
  const managerKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const spki=managerKey.publicKey.export({format:'der',type:'spki'});
  const deviceId=createHash('sha256').update(spki).digest('base64url');
  const password='Synthetic_native_84';
  await auth.createUser({uid,email:uid+'@example.test',password,emailVerified:true});
  await provisionTenant({db,auth,tenantId,uid,name:'مدير اختبار التسجيل',deviceId,publicKeySpki:spki.toString('base64url')});
  await db.doc('tenants/'+tenantId).update({name:'منشأة اختبار الدعوة',businessName:'منشأة اختبار الدعوة'});
  const employeeId='native_employee_record';
  await db.doc('tenants/'+tenantId+'/employees/'+employeeId).create({id:employeeId,name:'موظف اختبار الدعوة',active:true,revision:1});
  const request=data=>({data:{tenantId,deviceId,...data},auth:{uid,token:{auth_time:Math.floor(Date.now()/1000)+1}}});
  const challenge=await gateway.bootstrap(request({}));
  const session=await gateway.bootstrap(request({challengeId:challenge.challengeId,signature:sign('sha256',Buffer.from(challenge.challenge),managerKey.privateKey).toString('base64url')}));
  const invitation=await gateway.createEmployeeInvitation(request({sessionToken:session.sessionToken,employeeId}));
  return {projectId:DEMO_PROJECT_ID,tenantId,employeeId,email:'native_employee_'+suffix+'@example.test',password,
    invitationToken:invitation.invitationToken,businessName:'منشأة اختبار الدعوة'};
}
const bridge=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/evidence'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(metrics));return;
  }
  if(req.method==='POST'&&req.url==='/employee-fixture'){
    try {const fixture=await employeeFixture();res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(fixture));}
    catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'demo-employee-fixture-failed'}));console.error('demo-employee-fixture-failed',{type:error.name});}
    return;
  }
  try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('body-too-large');chunks.push(chunk);}
    const body=Buffer.concat(chunks);
    // Inspect parsed JSON rather than substring matching Android's slash escapes.
    const wireTotal=JSON.parse(body.toString()).data?.operation?.payload?.totalMinor;
    let wireKind;
    if(typeof wireTotal==='number'&&wireTotal===3000000000)wireKind='json-number';
    else if(wireTotal?.['@type']==='type.googleapis.com/google.protobuf.Int64Value'&&wireTotal.value==='3000000000')wireKind='int64-tag';
    else if(wireTotal?.['@type']==='type.googleapis.com/google.protobuf.UInt64Value'&&wireTotal.value==='3000000000')wireKind='uint64-tag';
    if(wireKind){metrics.largeIntegerWireRequests++;if(!metrics.largeIntegerWireKinds.includes(wireKind))metrics.largeIntegerWireKinds.push(wireKind);}
    if(wireKind==='int64-tag'||wireKind==='uint64-tag')metrics.taggedLargeInteger=true;
    const request=new Request('http://127.0.0.1:18787'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}: {})});
    const result=await handler(request);
    res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
    await writeFile(resolve(evidenceDir,'bridge-evidence.json'),JSON.stringify(metrics,null,2)+'\n');
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{status:'INTERNAL',message:'demo-bridge-error'}}));console.error('demo-bridge-error',{type:error.name});}
});
await new Promise(resolveStarted=>bridge.listen(18787,'127.0.0.1',resolveStarted));
const helper=startSeedHelper(publicKeys);
const child=spawn(process.execPath,[resolve(backend,'node_modules/firebase-tools/lib/bin/firebase.js'),'emulators:start','--project',DEMO_PROJECT_ID,'--config',configPath],{cwd:backend,env:process.env,stdio:'inherit'});
let stopping=false;
async function stop(){if(stopping)return;stopping=true;helper.close();bridge.close();child.kill('SIGINT');await app.delete().catch(()=>{});await unlink(secretPath).catch(()=>{});}
child.on('exit',async code=>{await stop();process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
console.log('Native external demo bridge on loopback18787; isolated Firebase hub4412/log4512. No production resources.');
