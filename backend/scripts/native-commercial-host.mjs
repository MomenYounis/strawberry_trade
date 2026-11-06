// Host half of the disposable Android acceptance campaign. This cannot run
// against production: every SDK endpoint/project and private runtime is checked
// before initialization. Private jobs never appear in ordinary evidence logs.
import {readFile,writeFile,stat,realpath,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createPublicKey} from 'node:crypto';
import {initializeApp,cert,deleteApp} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {provisionTenant,validateDevice} from '../src/enrollment.mjs';
import {transferDemoDevice} from '../src/demo-device-transfer.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';

const [phase,privateDirectory,inputFile]=process.argv.slice(2);
if(!['init','employee-job','manager-job','revoked-job','replacement-job','offline-job','offline-reopen-job','resume-offline-job','oracle-seed','oracle-review','oracle-final','oracle-offline'].includes(phase))throw Error('known-private-demo-phase-required');
const directory=await realpath(privateDirectory);
if(!(directory.startsWith('/tmp/strawberry-native-private-')||/^\/home\/younis\/\.local\/share\/strawberry-trade-test-runtime\/private-[a-z0-9_-]+$/.test(directory))||(await stat(directory)).mode&0o077)throw Error('private-campaign-directory-required');
const root=resolve(import.meta.dirname,'../..'),out=join(root,'verification/continuation-2026-11-02/native-durable');
const log=await readFile(join(out,'local-backend-serve.log'),'utf8');let runtime;
for(const line of log.split('\n'))try{const value=JSON.parse(line);if(value.state==='ready')runtime=value;}catch{}
if(!runtime||runtime.projectId!==DEMO_PROJECT_ID||!(runtime.runtimeRoot.startsWith('/tmp/strawberry-worker-http-')||/^\/home\/younis\/\.local\/share\/strawberry-trade-test-runtime\/backend-[a-z0-9_-]+$/.test(runtime.runtimeRoot))||runtime.ports.auth!==9099||runtime.ports.firestore!==8080||runtime.ports.worker!==8788)throw Error('owned-live-local-backend-required');
process.kill(runtime.pid,0);
if(!(await readFile('/proc/'+runtime.pid+'/cmdline')).includes(Buffer.from(runtime.runtimeRoot+'/backend/scripts/worker-http-test-runner.mjs')))throw Error('owned-live-backend-process-marker-required');
Object.assign(process.env,{GCLOUD_PROJECT:DEMO_PROJECT_ID,GOOGLE_CLOUD_PROJECT:DEMO_PROJECT_ID,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'});
assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
const fixtures={};
for(const line of (await readFile(join(runtime.runtimeRoot,'backend/worker/.dev.vars.emulator'),'utf8')).split('\n')){
 const at=line.indexOf('=');if(at<1||line.startsWith('#'))continue;const key=line.slice(0,at),value=line.slice(at+1);
 fixtures[key]=value.startsWith("'")?value.slice(1,-1):JSON.parse(value);
}
const account=JSON.parse(fixtures.FIREBASE_SERVICE_ACCOUNT_JSON);
if(account.project_id!==DEMO_PROJECT_ID||!account.client_email.startsWith('synthetic-worker@'))throw Error('synthetic-credentials-required');
const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert(account)},'native-commercial-host');
const db=initializeFirestore(app,{preferRest:true});db.settings(emulatorFirestoreSettings(DEMO_PROJECT_ID,process.env));const auth=getAuth(app);
const manifestFile=join(directory,'campaign.json');
const privateJson=async(path,value)=>writeFile(path,JSON.stringify(value),{mode:0o600,flag:'wx'});
const input=async()=>JSON.parse(await readFile(inputFile,'utf8'));
try{
 if(phase==='init'){
  const identity=await input();validateDevice(identity.publicKeySpki,identity.deviceId);
  const campaign='native_'+randomBytes(6).toString('hex'),accounts={};
  for(const suffix of ['A','B'])for(const role of ['manager','employee']){
   const uid=campaign+'_'+role+'_'+suffix.toLowerCase(),password='Synthetic_'+randomBytes(12).toString('hex');
   const user=await auth.createUser({uid,email:uid+'@example.test',emailVerified:true,password});
   accounts[role+suffix]={uid:user.uid,email:user.email,password,tenantId:campaign+'_'+suffix.toLowerCase()};
  }
  for(const name of ['managerA','managerB']){
   const value=accounts[name];await provisionTenant({db,auth,...value,name:'Synthetic native '+name,deviceId:identity.deviceId,publicKeySpki:identity.publicKeySpki});
  }
  const publicRaw=createPublicKey(fixtures.LICENSE_PUBLIC_KEY_PEM).export({type:'spki',format:'der'}).subarray(-32).toString('base64url');
  const manifest={campaign,accounts,sourceDeviceId:identity.deviceId,licensePublicKeys:{'worker-emulator-only':publicRaw}};
  await privateJson(manifestFile,manifest);await privateJson(join(directory,'manager-seed-job.json'),{...manifest,phase:'manager_seed'});
  console.log(JSON.stringify({status:'PASS',synthetic:true,phase,tenants:2,users:4,privateJobCreated:true}));
 }else{
  const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
  if(!/^native_[a-f0-9]{12}$/.test(manifest.campaign)||Object.values(manifest.accounts).some(a=>!a.tenantId.startsWith(manifest.campaign+'_')))throw Error('owned-demo-campaign-required');
  if(phase==='employee-job'){
   const source=await input();if(source.phase!=='manager_seed'||source.deviceId!==manifest.sourceDeviceId)throw Error('source-phase-required');
   await privateJson(join(directory,'employee-job.json'),{...manifest,phase:'employee_submit',invitations:{employeeA:source.invitations.managerA.invitationToken,employeeB:source.invitations.managerB.invitationToken}});
  }else if(['manager-job','revoked-job','offline-job','offline-reopen-job','resume-offline-job'].includes(phase)){
   const nativePhase={'manager-job':'manager_review','revoked-job':'employee_revoked','offline-job':'offline_transport','offline-reopen-job':'offline_reopen','resume-offline-job':'resume_offline'}[phase];
   await privateJson(join(directory,phase+'.json'),{...manifest,phase:nativePhase});
  }else if(phase==='replacement-job'){
   const identity=await input();validateDevice(identity.publicKeySpki,identity.deviceId);if(identity.deviceId===manifest.sourceDeviceId)throw Error('distinct-keystore-required');
   const value=manifest.accounts.managerA;
   await transferDemoDevice({db,auth,projectId:DEMO_PROJECT_ID,request:{tenantId:value.tenantId,uid:value.uid,revokeDeviceId:manifest.sourceDeviceId,deviceId:identity.deviceId,publicKeySpki:identity.publicKeySpki}});
   await privateJson(join(directory,'replacement-job.json'),{...manifest,phase:'replacement'});
  }else{
   const a=manifest.accounts.managerA,b=manifest.accounts.managerB;
   const accepted=await db.doc('tenants/'+a.tenantId).collection('entries').get();const rows=accepted.docs.map(d=>d.data());
   const baseline={customer:5000,supplier:7000};let cash=0,customer=baseline.customer,supplier=baseline.supplier;
   const byId=new Map(rows.map(e=>[e.id,e]));
   // An independent integer oracle: explicit effect equations, no app/backend
   // report or LedgerRules implementation is imported.
   function effect(e,sign=1){
    const paid=e.paidMinor??0,total=e.totalMinor??0;
    const debt=['sale','purchase'].includes(e.kind)?total-paid:['sale_return','purchase_return'].includes(e.kind)?paid-total:['merchant_payment','supplier_payment'].includes(e.kind)?-paid:0;
    if(e.partyId==='customer')customer+=sign*debt;if(e.partyId==='supplier')supplier+=sign*debt;
    cash+=sign*(['sale','merchant_payment','purchase_return'].includes(e.kind)?paid:-paid);
   }
   for(const e of rows){if(e.kind==='reversal'){const original=byId.get(e.originalId);if(!original||original.kind==='reversal')throw Error('oracle-original-required');effect(original,-1);}else effect(e);}
   const expectedCustomer=phase==='oracle-seed'?15000:phase==='oracle-review'?17000:phase==='oracle-offline'?20000:18500;
   const expectedCash=phase==='oracle-offline'?-6700:phase==='oracle-final'?-7200:-7700;
   if(customer!==expectedCustomer||supplier!==8000||cash!==expectedCash||byId.has('lost_only')||byId.has('employee_forbidden'))throw Error('independent-oracle-mismatch');
   const bRows=(await db.doc('tenants/'+b.tenantId).collection('entries').get()).docs.map(d=>d.data());
   const bDebt=bRows.reduce((n,e)=>n+e.totalMinor-e.paidMinor,700);if(bDebt!==(phase==='oracle-seed'?2700:4700))throw Error('second-tenant-oracle-mismatch');
   const returns=(await db.doc('tenants/'+a.tenantId+'/returnCounters/accepted_sale').get()).data();if(returns.qtyMilli!==2000||returns.totalMinor!==4000)throw Error('return-counter-mismatch');
   if(phase!=='oracle-seed')for(const value of [a,b]){
    const rejected=(await db.doc('tenants/'+value.tenantId+'/submissions/rejected_expense').get()).data();if(rejected.status!=='rejected')throw Error('rejection-not-recorded');
   }
   if(phase==='oracle-offline'){
    const operationId='replacement_offline_pending',entry=byId.get(operationId);
    const receipt=(await db.doc('tenants/'+a.tenantId+'/operations/'+operationId).get()).data();
    if(rows.filter(row=>row.id===operationId).length!==1||entry?.kind!=='sale'||entry.totalMinor!==2000||entry.paidMinor!==500||entry.creatorUid!==a.uid
      ||receipt?.result?.id!==operationId||receipt.result.status!=='accepted'||receipt.actorUid!==a.uid)throw Error('offline-original-operation-receipt-mismatch');
   }
   const evidence={status:'PASS',synthetic:true,phase,campaign:manifest.campaign,customerMinor:customer,supplierMinor:supplier,recordedCashMinor:cash,secondTenantCustomerMinor:bDebt,acceptedEntries:rows.length,lostOnlyAbsent:true,returnCounterPreserved:true,productionDataUsed:false};
   if(phase==='oracle-offline')Object.assign(evidence,{offlineOriginalOperationAcceptedOnce:true,acceptedReceiptBoundToOriginalId:true});
   // Campaign-specific, create-only evidence keeps a later run from replacing
   // the independent financial oracle of an earlier accepted campaign.
   const evidenceDirectory=join(out,'campaigns',manifest.campaign);
   await mkdir(evidenceDirectory,{recursive:true});
   await writeFile(join(evidenceDirectory,phase+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
  }
  if(!phase.startsWith('oracle-'))console.log(JSON.stringify({status:'PASS',synthetic:true,phase,privateJobCreated:true}));
 }
}finally{await deleteApp(app);}
