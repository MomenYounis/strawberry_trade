// Local historical-client campaign only. Never deploy this operator.
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createPublicKey} from 'node:crypto';
import {initializeApp,cert,deleteApp} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';
import {provisionTenant,validateDevice} from '../src/enrollment.mjs';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';

const [phase,directoryArg,identityArg]=process.argv.slice(2);
const phases=['init','minimum-v1','minimum-v2','unsupported-job','v11-job','v12-job','oracle-seed','oracle-unsupported','oracle-v11','oracle-v12'];
if(!phases.includes(phase))throw Error('known-legacy-demo-phase-required');
const directory=await realpath(directoryArg);
if(!/^\/home\/younis\/\.local\/share\/strawberry-trade-test-runtime\/private-legacy-[a-z0-9_-]+$/.test(directory)
  ||!(await stat(directory)).isDirectory()||((await stat(directory)).mode&0o077))throw Error('private-legacy-campaign-directory-required');
const root=resolve(import.meta.dirname,'../..');
const log=await readFile(join(root,'verification/continuation-2026-11-02/native-durable/local-backend-serve.log'),'utf8');
let runtime;
for(const line of log.split('\n'))try{const value=JSON.parse(line);if(value.state==='ready')runtime=value;}catch{}
if(!runtime||runtime.projectId!==DEMO_PROJECT_ID
  ||!/^\/home\/younis\/\.local\/share\/strawberry-trade-test-runtime\/backend-[a-z0-9_-]+$/.test(runtime.runtimeRoot)
  ||runtime.ports.auth!==9099||runtime.ports.firestore!==8080||runtime.ports.worker!==8788)throw Error('owned-durable-local-backend-required');
process.kill(runtime.pid,0);
if(!(await readFile('/proc/'+runtime.pid+'/cmdline')).includes(Buffer.from(runtime.runtimeRoot+'/backend/scripts/worker-http-test-runner.mjs')))throw Error('owned-backend-process-marker-required');
const runtimeStat=await stat(runtime.runtimeRoot);
if(!runtimeStat.isDirectory()||(runtimeStat.mode&0o077))throw Error('private-owned-backend-required');
// Both emulator boundaries are fixed and validated before SDK initialization.
Object.assign(process.env,{GCLOUD_PROJECT:DEMO_PROJECT_ID,GOOGLE_CLOUD_PROJECT:DEMO_PROJECT_ID,
  FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'});
assertDemoOperatorEnvironment(DEMO_PROJECT_ID,process.env);
const fixtures={};
const vars=await readFile(join(runtime.runtimeRoot,'backend/worker/.dev.vars.emulator'),'utf8');
if(!vars.startsWith('# Synthetic loopback fixtures. These are not Google credentials.'))throw Error('synthetic-backend-fixture-marker-required');
for(const line of vars.split('\n')){
  const at=line.indexOf('=');if(at<1||line.startsWith('#'))continue;
  const value=line.slice(at+1);fixtures[line.slice(0,at)]=value.startsWith("'")?value.slice(1,-1):JSON.parse(value);
}
const account=JSON.parse(fixtures.FIREBASE_SERVICE_ACCOUNT_JSON);
if(account.project_id!==DEMO_PROJECT_ID||!account.client_email.startsWith('synthetic-worker@'))throw Error('synthetic-demo-credentials-required');
const runtimeVars=JSON.parse(await readFile(join(runtime.runtimeRoot,'backend/worker/wrangler.jsonc'),'utf8')).env?.emulator?.vars;
const publicKey=createPublicKey(fixtures.LICENSE_PUBLIC_KEY_PEM).export({format:'jwk'});
if(runtimeVars?.LICENSE_KEY_ID!=='worker-emulator-only'||runtimeVars?.FIREBASE_PROJECT_ID!==DEMO_PROJECT_ID
  ||publicKey.kty!=='OKP'||publicKey.crv!=='Ed25519')throw Error('synthetic-demo-issuer-required');
const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert(account)},'native-legacy-host');
const db=initializeFirestore(app,{preferRest:true});db.settings(emulatorFirestoreSettings(DEMO_PROJECT_ID,process.env));
const auth=getAuth(app);
const privateJson=async(name,value)=>writeFile(join(directory,name),JSON.stringify(value),{mode:0o600,flag:'wx'});
const manifestPath=join(directory,'legacy-campaign.json');
try{
  if(phase==='init'){
    const identityPath=await realpath(identityArg);
    if(!identityPath.startsWith(directory+'/')||((await stat(identityPath)).mode&0o077))throw Error('private-native-identity-required');
    const identity=JSON.parse(await readFile(identityPath,'utf8'));
    if(identity.phase!=='identity'||identity.synthetic!==true||identity.client!=='v9')throw Error('actual-v9-fixture-identity-required');
    validateDevice(identity.publicKeySpki,identity.deviceId);
    const campaign='legacy_'+randomBytes(6).toString('hex');
    const uid=campaign+'_manager',tenantId=campaign+'_business',password='Synthetic_'+randomBytes(16).toString('hex');
    const user=await auth.createUser({uid,email:uid+'@example.test',emailVerified:true,password});
    await provisionTenant({db,auth,tenantId,uid,name:'Historical client synthetic business',
      deviceId:identity.deviceId,publicKeySpki:identity.publicKeySpki});
    await db.doc('tenants/'+tenantId).update({minimumSyncProtocol:1,legacyCompatibilityFixture:campaign});
    const manifest={campaign,accounts:{managerA:{uid,email:user.email,password,tenantId}},
      sourceDeviceId:identity.deviceId,licensePublicKeys:{'worker-emulator-only':publicKey.x}};
    await privateJson('legacy-campaign.json',manifest);
    await privateJson('legacy-seed-v9-job.json',{...manifest,phase:'legacy_seed_v9'});
    console.log(JSON.stringify({status:'PASS',synthetic:true,phase,tenants:1,users:1,privateJobCreated:true}));
  }else{
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    if(!/^legacy_[a-f0-9]{12}$/.test(manifest.campaign))throw Error('owned-legacy-campaign-required');
    const a=manifest.accounts.managerA;
    if(a.tenantId!==manifest.campaign+'_business'||a.uid!==manifest.campaign+'_manager')throw Error('owned-legacy-account-required');
    const tenant=db.doc('tenants/'+a.tenantId),snapshot=await tenant.get();
    if(snapshot.data()?.legacyCompatibilityFixture!==manifest.campaign||snapshot.data()?.ownerUid!==a.uid)throw Error('owned-synthetic-tenant-marker-required');
    if(phase.startsWith('minimum-')){
      const minimum=phase==='minimum-v2'?2:1;
      await db.runTransaction(async tx=>{
        const current=await tx.get(tenant);
        if(current.data()?.legacyCompatibilityFixture!==manifest.campaign||current.data()?.ownerUid!==a.uid)throw Error('owned-synthetic-tenant-marker-required');
        tx.update(tenant,{minimumSyncProtocol:minimum});
      });
      console.log(JSON.stringify({status:'PASS',synthetic:true,phase,minimumSyncProtocol:minimum}));
    }else if(phase.endsWith('-job')){
      const requested=phase==='unsupported-job'?'legacy_unsupported_v9':phase==='v11-job'?'legacy_resume_v11':'legacy_resume_v12';
      await privateJson(phase+'.json',{...manifest,phase:requested});
      console.log(JSON.stringify({status:'PASS',synthetic:true,phase,privateJobCreated:true}));
    }else{
      const rows=(await tenant.collection('entries').get()).docs.map(d=>d.data());
      const receipts=(await tenant.collection('operations').get()).docs.map(d=>({id:d.id,...d.data()}));
      const accepted=phase==='oracle-seed'||phase==='oracle-unsupported'
        ?['compat_v9_accepted']
        :phase==='oracle-v11'?['compat_v9_accepted','compat_v9_pending','compat_v11_accepted']
        :['compat_v9_accepted','compat_v9_pending','compat_v11_accepted','compat_v11_pending','compat_v12_accepted'];
      const ids=rows.map(e=>e.id).sort();
      if(JSON.stringify(ids)!==JSON.stringify([...accepted].sort()))throw Error('legacy-independent-accepted-entry-set-mismatch');
      const expected={
        compat_v9_accepted:{totalMinor:2000,paidMinor:500},
        compat_v9_pending:{totalMinor:3000,paidMinor:500},
        compat_v11_accepted:{totalMinor:4000,paidMinor:1000},
        compat_v11_pending:{totalMinor:4500,paidMinor:500},
        compat_v12_accepted:{totalMinor:5000,paidMinor:1000},
      };
      let cash=0,balance=100;
      for(const row of rows){
        const wanted=expected[row.id];
        if(row.tenantId!==a.tenantId||row.creatorUid!==a.uid||row.kind!=='sale'||row.partyId!=='compat_customer'
          ||row.totalMinor!==wanted.totalMinor||row.paidMinor!==wanted.paidMinor)throw Error('legacy-independent-financial-fact-mismatch');
        cash+=row.paidMinor;balance+=row.totalMinor-row.paidMinor;
      }
      const party=(await tenant.collection('parties').doc('compat_customer').get()).data();
      if(party?.openingMinor!==100||party.tenantId!==a.tenantId)throw Error('legacy-independent-opening-mismatch');
      const wantedReceipts=['compat_customer',...accepted].sort();
      if(JSON.stringify(receipts.map(r=>r.id).sort())!==JSON.stringify(wantedReceipts)
        ||receipts.some(r=>r.result?.status!=='accepted'||r.actorUid!==a.uid))throw Error('legacy-independent-receipt-set-mismatch');
      const wantedBalance=accepted.reduce((n,id)=>n+expected[id].totalMinor-expected[id].paidMinor,100);
      const wantedCash=accepted.reduce((n,id)=>n+expected[id].paidMinor,0);
      if(balance!==wantedBalance||cash!==wantedCash)throw Error('legacy-independent-integer-oracle-mismatch');
      const summary={status:'PASS',synthetic:true,phase,acceptedEntries:rows.length,
        operationReceipts:receipts.length,customerBalanceMinor:balance,recordedCashMinor:cash,
        pendingOperationNotAccepted:true,duplicateDeliveryHasOneReceipt:true,productionDataUsed:false};
      // Only summaries leave the private campaign; account/job values stay private.
      const evidence=join(root,'verification/continuation-2026-11-02/compatibility',phase+'.json');
      await writeFile(evidence,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify(summary));
    }
  }
}finally{await deleteApp(app);}
