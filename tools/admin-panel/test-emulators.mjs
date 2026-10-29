/** Explicit, opt-in acceptance against local emulators. Never imported by npm test.
 * No production credentials/configuration module is loaded. Production guards in
 * operations.mjs stay unchanged: only this test's injected facade advertises the
 * guarded target; the real clients and every actual resource use a demo project.
 * Run: node test-emulators.mjs [--evidence-dir=/absolute/directory]
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const PROJECT='demo-strawberry-admin',FIRESTORE='127.0.0.1:18081',AUTH='127.0.0.1:19099';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(new URL('../../backend/package.json',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const device=()=>{const {publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),bytes=publicKey.export({type:'spki',format:'der'});return {deviceId:createHash('sha256').update(bytes).digest('base64url'),publicKeySpki:bytes.toString('base64url'),algorithm:'P256-SHA256'};};
async function portFree(endpoint){const [host,port]=endpoint.split(':');await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(Number(port),host,()=>s.close(resolve));});}
async function ready(endpoint,child){const [host,port]=endpoint.split(':');for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error('local-emulator-exited');const ok=await new Promise(resolve=>{const s=net.connect({host,port:Number(port)});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});if(ok)return;await sleep(100);}throw Error('local-emulator-start-timeout');}

async function isolated(evidenceDirectory,tempDirectory){
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST,FIRESTORE);assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST,AUTH);
  assert.equal(process.env.GCLOUD_PROJECT,PROJECT);assert.equal(process.env.GOOGLE_CLOUD_PROJECT,PROJECT);
  assert.equal(process.env.XDG_CONFIG_HOME,join(tempDirectory,'empty-config'));
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS,undefined);assert.equal(process.env.FIREBASE_TOKEN,undefined);
  await Promise.all([portFree(FIRESTORE),portFree(AUTH)]);
  // Fail closed before SDK imports if a dependency attempts any external socket
  // (including metadata credential discovery). There is no network allowlist
  // exception for Google or the production project.
  const connect=net.Socket.prototype.connect;
  net.Socket.prototype.connect=function(...args){
    const value=Array.isArray(args[0])?args[0][0]:args[0];
    const socketHost=value&&typeof value==='object'?(value.host||value.hostname||'localhost'):typeof value==='number'?(args[1]||'localhost'):null;
    if(socketHost!==null&&!['127.0.0.1','localhost','::1','[::1]'].includes(socketHost))throw Error('external-network-forbidden-in-emulator-test');
    if(socketHost===null&&!(typeof value==='string'&&isAbsolute(value)))throw Error('unknown-network-target-forbidden-in-emulator-test');
    return connect.apply(this,args);
  };
  const rules=join(tempDirectory,'firestore.rules');
  await writeFile(rules,"rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }\n");
  const jar=join(homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.22.0.jar');
  await readFile(jar,{flag:'r'}); // Already cached dependency only; no download.
  const [host,port]=FIRESTORE.split(':');
  const firestoreProcess=spawn('java',['-jar',jar,'--host',host,'--port',port,'--project_id',PROJECT,'--single_project_mode','--single_project_mode_error','--rules',rules],{cwd:tempDirectory,env:process.env,stdio:['ignore','pipe','pipe']});
  // Emulator output contains only synthetic traffic, but keep console succinct.
  let emulatorLog='';for(const stream of [firestoreProcess.stdout,firestoreProcess.stderr])stream.on('data',chunk=>{emulatorLog+=chunk;});
  let authEmulator,db,app,credentialCalls=0;
  const checks=[];
  const check=(name,details={})=>{checks.push({name,passed:true,...details});console.log('PASS '+name);};
  const acceptance={schemaVersion:1,projectId:PROJECT,endpoints:{firestore:FIRESTORE,auth:AUTH},productionCredentialsLoaded:false,productionConfigurationImported:false,networkTarget:'loopback-only-explicit-emulator-clients',checks};
  try{
    const firebasePath=dirname(require.resolve('firebase-tools/package.json'));
    const {AuthEmulator,SingleProjectMode}=require(join(firebasePath,'lib/emulator/auth/index.js'));
    authEmulator=new AuthEmulator({projectId:PROJECT,host:'127.0.0.1',port:19099,singleProjectMode:SingleProjectMode.ERROR});
    await authEmulator.start();await ready(FIRESTORE,firestoreProcess);
    const {Firestore}=require('@google-cloud/firestore');
    const {GoogleAuth,OAuth2Client}=require('google-auth-library');
    const {initializeApp,deleteApp}=require('firebase-admin/app');
    const {getAuth}=require('firebase-admin/auth');
    const {createAdminOperations,ADMIN_PROJECT_ID}=await import('./operations.mjs');
    app=initializeApp({projectId:PROJECT,credential:{getAccessToken:async()=>{credentialCalls++;throw Error('test-must-never-fetch-credentials');}}},'local-admin-emulator-'+randomUUID());
    const actualAuth=getAuth(app);
    // The REST transport still asks GoogleAuth for a header, even for an
    // emulator. Supply its documented synthetic owner token explicitly so it
    // never falls back to ADC or a metadata server.
    const syntheticAuth=new OAuth2Client();syntheticAuth.setCredentials({access_token:'owner',expiry_date:Number.MAX_SAFE_INTEGER});
    syntheticAuth.refreshTokenNoCache=async()=>{credentialCalls++;throw Error('test-must-never-fetch-credentials');};
    db=new Firestore({projectId:PROJECT,databaseId:'(default)',host:FIRESTORE,ssl:false,preferRest:true,auth:new GoogleAuth({projectId:PROJECT,authClient:syntheticAuth})});
    assert.equal(db.projectId,PROJECT);assert.equal(db.databaseId,'(default)');
    assert.equal(db._settings.servicePath,'127.0.0.1');assert.equal(db._settings.port,18081);assert.equal(db._settings.ssl,false);
    assert.equal(actualAuth.app.options.projectId,PROJECT);assert.equal(actualAuth.emulatorConfig?.host??'127.0.0.1','127.0.0.1');
    // This is dependency injection for the unchanged target check, never a
    // production switch or alternate credential path.
    const dbFacade={projectId:ADMIN_PROJECT_ID,databaseId:'(default)',doc:path=>db.doc(path),collection:path=>db.collection(path),runTransaction:(...args)=>db.runTransaction(...args),recursiveDelete:(...args)=>db.recursiveDelete(...args)};
    const authFacade={app:{options:{projectId:ADMIN_PROJECT_ID}},getUser:(...args)=>actualAuth.getUser(...args),getUserByEmail:(...args)=>actualAuth.getUserByEmail(...args),createUser:(...args)=>actualAuth.createUser(...args)};
    const makeOps=()=>createAdminOperations({db:dbFacade,auth:authFacade,receiptDirectory:join(tempDirectory,'receipts')});
    let ops=makeOps();
    const execute=async action=>{const p=await ops.previewAction(action);return ops.executeAction({previewId:p.previewId,confirmation:p.confirmationText});};
    check('actual SDK clients target only demo project and loopback emulator endpoints');
    assert.deepEqual(await ops.lookupAccount({email:'owner@example.test'}),{found:false,account:null});
    const ownerCreated=await execute({type:'create-account',email:'owner@example.test',displayName:'Synthetic owner',password:'Synthetic_owner_123!',sendVerificationEmail:false});
    assert.equal(ownerCreated.account.emailVerified,false);assert.equal(ownerCreated.verificationEmailSent,false);
    assert.equal(JSON.stringify(ownerCreated).includes('Synthetic_owner_123!'),false);
    const ownerUid=ownerCreated.account.uid;
    await assert.rejects(ops.previewAction({type:'create-tenant',tenantId:'synthetic-tenant',name:'Synthetic business',ownerUid,expectedEmail:'owner@example.test',deviceRequest:device(),maxDevices:2}),/verified-enabled-account-required/);
    await actualAuth.updateUser(ownerUid,{emailVerified:true});
    check('real Auth emulator creates account unverified and tenant requires verification');
    const ownerDevice=device(),create={type:'create-tenant',tenantId:'synthetic-tenant',name:'Synthetic business',ownerUid,expectedEmail:'owner@example.test',deviceRequest:ownerDevice,maxDevices:2};
    const preview=await ops.previewAction(create);assert.equal((await db.doc('tenants/synthetic-tenant').get()).exists,false);
    const created=await ops.executeAction({previewId:preview.previewId,confirmation:preview.confirmationText});
    assert.equal(created.status,'applied');assert.equal(created.trialEndMs-created.trialStartMs,30*86400000);
    const original=(await db.doc('tenants/synthetic-tenant').get()).data();assert.equal(original.trialStartMs,created.trialStartMs);
    assert.ok(Math.abs(Date.now()-original.trialStartMs)<30000);assert.equal((await db.doc('tenants/synthetic-tenant').get()).ref.firestore.projectId,PROJECT);
    assert.equal((await db.collection('adminEnrollmentHistory').get()).size,1);assert.equal((await db.collection('adminTenantHistory').get()).size,1);
    assert.deepEqual(await ops.executeAction({previewId:preview.previewId,confirmation:preview.confirmationText}),created);
    check('real Firestore readTime transactions create trial membership device histories and retry receipt');
    const managerCreated=await execute({type:'create-account',email:'manager@example.test',displayName:'Synthetic manager',password:'Synthetic_manager_123!',sendVerificationEmail:false});
    const managerUid=managerCreated.account.uid;await actualAuth.updateUser(managerUid,{emailVerified:true});
    await execute({type:'add-manager',tenantId:'synthetic-tenant',uid:managerUid,expectedEmail:'manager@example.test',name:'Synthetic manager',deviceRequest:device()});
    let detail=await ops.tenantDetail({tenantId:'synthetic-tenant'});assert.equal(detail.members.length,2);assert.equal(detail.devices.length,2);assert.equal(detail.tenant.managerDeviceCount,2);
    await execute({type:'set-member-active',tenantId:'synthetic-tenant',uid:managerUid,active:false});
    detail=await ops.tenantDetail({tenantId:'synthetic-tenant'});assert.equal(detail.tenant.managerDeviceCount,1);assert.equal(detail.members.find(m=>m.uid===managerUid).active,false);assert.equal(detail.devices.find(d=>d.uid===managerUid).active,false);
    await execute({type:'set-member-active',tenantId:'synthetic-tenant',uid:managerUid,active:true});
    assert.equal((await ops.tenantDetail({tenantId:'synthetic-tenant'})).tenant.managerDeviceCount,2);
    await execute({type:'set-tenant-enabled',tenantId:'synthetic-tenant',enabled:false});assert.equal((await ops.tenantDetail({tenantId:'synthetic-tenant'})).tenant.enabled,false);
    await execute({type:'set-tenant-enabled',tenantId:'synthetic-tenant',enabled:true});
    check('real transactions add manager disable reactivate and toggle tenant');
    const paid=await execute({type:'activate-license',tenantId:'synthetic-tenant',unit:'months',count:1,maxDevices:3});assert.ok(paid.expiresAtMs>original.trialEndMs);
    const paidTenant=(await db.doc('tenants/synthetic-tenant').get()).data();assert.equal(paidTenant.trialStartMs,original.trialStartMs);assert.equal(paidTenant.trialEndMs,original.trialEndMs);assert.equal(paidTenant.entitlementPayload.expiresAtMs,paid.expiresAtMs);
    await execute({type:'activate-license',tenantId:'synthetic-tenant',unit:'permanent'});
    assert.equal((await db.doc('tenants/synthetic-tenant').get()).data().entitlementPayload.expiresAtMs,null);
    await assert.rejects(ops.previewAction({type:'activate-license',tenantId:'synthetic-tenant',unit:'days',count:1}),/permanent-license-cannot-be-shortened/);
    check('paid and permanent license writes preserve original trial and cannot shorten permanent');
    await db.doc('tenants/synthetic-tenant/entries/synthetic-entry').set({amount:1,synthetic:true});
    await db.doc('tenants/synthetic-tenant/missing/ghost/nested/orphan').set({synthetic:true});
    const listing=await ops.listTenants();assert.equal(listing.items.length,1);assert.equal(JSON.stringify(listing).includes('synthetic-entry'),false);
    const firstDelete=await execute({type:'delete-tenant',tenantId:'synthetic-tenant'});assert.equal(firstDelete.status,'delete-pending');
    assert.equal((await db.doc('tenants/synthetic-tenant').get()).exists,false);
    assert.equal((await db.doc('tenants/synthetic-tenant/entries/synthetic-entry').get()).exists,false);
    assert.equal((await db.doc('tenants/synthetic-tenant/missing/ghost/nested/orphan').get()).exists,false);
    check('real recursiveDelete purges financial child and orphan nested below nonexistent parent');
    ops=makeOps();detail=await ops.tenantDetail({tenantId:'synthetic-tenant'});
    assert.equal(detail.tenant.missingParent,true);assert.equal(detail.tenant.deleting,true);assert.equal(detail.members.length,0);
    assert.equal((await ops.listTenants()).items[0].deleting,true);
    await assert.rejects(ops.previewAction({...create,tenantId:'synthetic-other'}),/tenant-or-owner-history-exists/);
    check('reloaded operations list pending deletion and block trial reset from enrollment history');
    console.log('Waiting for the real 30-second quiet window before deletion completion.');
    await sleep(Math.max(0,firstDelete.nextCheckAfterMs-Date.now()+200));
    const deleted=await execute({type:'delete-tenant',tenantId:'synthetic-tenant'});assert.equal(deleted.status,'deleted');
    assert.equal((await ops.listTenants()).items.length,0);await assert.rejects(ops.tenantDetail({tenantId:'synthetic-tenant'}),/tenant-not-found/);
    for(const uid of [ownerUid,managerUid])assert.equal((await actualAuth.getUser(uid)).disabled,false);
    assert.equal((await actualAuth.listUsers()).users.length,2);
    assert.equal((await db.doc('adminTenantHistory/synthetic-tenant').get()).data().state,'deleted');
    assert.equal((await db.doc('tenants/synthetic-tenant').listCollections()).length,0);
    assert.equal(credentialCalls,0);
    check('real quiet-window resume completes deletion and keeps Auth users plus minimal history');
    acceptance.passed=true;acceptance.credentialFetchCalls=credentialCalls;acceptance.completedAt=new Date().toISOString();
    await deleteApp(app);app=null;
  }catch(error){acceptance.passed=false;acceptance.failure={name:error.name,code:error.code||null,message:String(error.message).slice(0,300)};throw error;}
  finally{
    acceptance.credentialFetchCalls=credentialCalls;
    await mkdir(evidenceDirectory,{recursive:true,mode:0o700});
    await writeFile(join(evidenceDirectory,'operations-emulator-acceptance.json'),JSON.stringify(acceptance,null,2)+'\n',{mode:0o600});
    await writeFile(join(evidenceDirectory,'operations-emulator-java.log'),emulatorLog,{mode:0o600});
    if(db)await db.terminate().catch(()=>{});
    if(app)await require('firebase-admin/app').deleteApp(app).catch(()=>{});
    if(authEmulator)await authEmulator.stop().catch(()=>{});
    if(firestoreProcess.exitCode===null){firestoreProcess.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{firestoreProcess.kill('SIGKILL');resolve();},5000);firestoreProcess.once('exit',()=>{clearTimeout(timer);resolve();});});}
  }
}

if(process.argv[2]==='--isolated-run'){
  try{await isolated(process.argv[3],process.argv[4]);}
  catch(error){console.error('FAIL '+(error.code||error.message||'emulator-acceptance-failed'));process.exitCode=1;}
}else{
  const output=process.argv.slice(2);assert.ok(output.length<=1&&(!output[0]||output[0].startsWith('--evidence-dir=')),'Use only --evidence-dir=/absolute/directory');
  const tempDirectory=await mkdtemp(join(tmpdir(),'strawberry-admin-emulators-'));
  const evidenceDirectory=output[0]?.slice('--evidence-dir='.length)||join(tempDirectory,'evidence');assert.ok(isAbsolute(evidenceDirectory));
  await mkdir(evidenceDirectory,{recursive:true,mode:0o700});await mkdir(join(tempDirectory,'empty-config'),{mode:0o700});
  const env={PATH:process.env.PATH,LANG:'C.UTF-8',XDG_CONFIG_HOME:join(tempDirectory,'empty-config'),GCLOUD_PROJECT:PROJECT,GOOGLE_CLOUD_PROJECT:PROJECT,FIRESTORE_EMULATOR_HOST:FIRESTORE,FIREBASE_AUTH_EMULATOR_HOST:AUTH,CI:'true',NO_COLOR:'1'};
  if(process.env.JAVA_HOME)env.JAVA_HOME=process.env.JAVA_HOME;
  const child=spawn(process.execPath,[join(here,'test-emulators.mjs'),'--isolated-run',evidenceDirectory,tempDirectory],{cwd:tempDirectory,env,stdio:['ignore','pipe','pipe']});
  let log='';for(const [name,stream]of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',chunk=>{log+=chunk;process[name].write(chunk);});
  const code=await new Promise(resolve=>child.once('exit',resolve));
  await writeFile(join(evidenceDirectory,'operations-emulator-stdout.log'),log,{mode:0o600});
  if(output[0])await rm(tempDirectory,{recursive:true,force:true});
  console.log('Emulator evidence: '+evidenceDirectory);process.exitCode=code??1;
}
