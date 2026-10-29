import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEnrollmentPlan} from './plan.mjs';
import {applyEnrollment,validateApplication,requiredApprovalConfirmations} from './apply.mjs';

const projectId='strawberry-operator-test',databaseId='(default)',serverTime=1800000000123;
function fixture(){
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'der',type:'spki'});
  const target={projectId,databaseId,ownerUid:'synthetic_owner',expectedEmail:'owner@example.test',tenantId:'synthetic_tenant',managerName:'مالك',deviceId:createHash('sha256').update(key).digest('base64url'),publicKeySpki:key.toString('base64url'),maxDevices:1};
  const plan=createEnrollmentPlan(target,{projectId,databaseId});
  const approval={schemaVersion:1,kind:'strawberry-owner-enrollment-approval',projectId,databaseId,planHashSha256:plan.planHashSha256,target,publicKeySha256Hex:plan.publicKeySha256Hex,humanApprovalEvidence:'SYNTHETIC TEST APPROVAL ONLY; never authorizes any real account.',...Object.fromEntries(requiredApprovalConfirmations.map(k=>[k,true]))};
  const input={plan,approval,projectId,databaseId,planHashSha256:plan.planHashSha256};
  const state={docs:new Map(),receipt:null,revocations:0,transactionCalls:0,readTimesByTransaction:[],failCommit:false,loseCommitResponse:false,failRevoke:false,injectPriorOwnerAtCommit:false};
  const snapshot=(path,time=serverTime)=>({id:path.split('/').at(-1),exists:state.docs.has(path),data:()=>structuredClone(state.docs.get(path)),readTime:{toMillis:()=>time}});
  const db={projectId,databaseId,doc:path=>({path}),collection:()=>({where:()=>({limit:()=>({query:true})})}),async runTransaction(callback){
    const writes=[];let writing=false;state.transactionCalls++;
    if(state.injectPriorOwnerAtCommit&&state.transactionCalls===2)state.docs.set('tenants/other',{ownerUid:'synthetic_owner'});
    const clock=state.readTimesByTransaction[state.transactionCalls-1]||{};
    const tx={getAll:async(...refs)=>{assert.equal(writing,false);return refs.map((ref,i)=>snapshot(ref.path,clock.documents&&i<clock.documents.length?clock.documents[i]:serverTime));},get:async()=>{assert.equal(writing,false);return {docs:[...state.docs].filter(([p,d])=>p.split('/').length===2&&d.ownerUid==='synthetic_owner').map(([p])=>snapshot(p)),readTime:{toMillis:()=>Object.hasOwn(clock,'query')?clock.query:serverTime}};},create(ref,data){writing=true;if(state.docs.has(ref.path))throw Error('ALREADY_EXISTS');writes.push([ref.path,structuredClone(data)]);}};
    const result=await callback(tx);if(state.failCommit&&writes.length)throw Error('COMMIT FAILED');for(const [path,data]of writes)state.docs.set(path,data);if(state.loseCommitResponse&&writes.length){state.loseCommitResponse=false;throw Error('LOST RESPONSE');}return result;
  }};
  const auth={app:{options:{projectId}},getUser:async()=>({uid:target.ownerUid,email:target.expectedEmail,emailVerified:true,disabled:false}),revokeRefreshTokens:async()=>{state.revocations++;if(state.failRevoke)throw Error('LOST AUTH RESPONSE');}};
  const receiptStore={read:async()=>structuredClone(state.receipt),write:async(value)=>{state.receipt=structuredClone(value);}};
  return {input,state,clients:{db,auth,receiptStore}};
}
test('requires a rebuilt exact plan and separate specific approval before any client action',async()=>{
  const f=fixture();f.input.plan.proposedActions[1].documents[0].data.enabled=false;
  assert.throws(()=>validateApplication(f.input),/plan-content/);
  const g=fixture();delete g.input.approval.manualOwnerAndPhysicalPhoneKeyHandoffConfirmed;
  await assert.rejects(applyEnrollment(g.input,g.clients),/specific-human-approval/);assert.equal(g.state.transactionCalls,0);assert.equal(g.state.revocations,0);
});
test('creates exactly four docs, all reads precede writes, trial uses trusted server readTime',async()=>{
  const f=fixture(),result=await applyEnrollment(f.input,f.clients);
  assert.equal(result.trialStartMs,serverTime);assert.equal(result.trialEndMs-serverTime,2592000000);
  assert.equal(f.state.docs.size,4);assert.equal(f.state.revocations,1);assert.equal(f.state.receipt.state,'complete');
  const retry=await applyEnrollment(f.input,f.clients);assert.equal(retry.status,'already-applied');assert.equal(f.state.revocations,1);
});
test('different final document/query read metadata uses the latest trusted timestamp at millisecond precision',async()=>{
  const f=fixture();
  f.state.readTimesByTransaction=[{},
    {documents:[serverTime+200.75,serverTime+201.5,serverTime+203.875,serverTime+202.25],query:serverTime+201.75}];
  const result=await applyEnrollment(f.input,f.clients);
  assert.equal(result.trialStartMs,serverTime+203);
  assert.equal(result.trialEndMs-result.trialStartMs,2592000000);
  assert.equal(f.state.docs.get('tenants/synthetic_tenant').trialStartMs,result.trialStartMs);
});
test('trial clock comes from the final transaction, not preliminary reads or the workstation clock',async()=>{
  const f=fixture();
  f.state.readTimesByTransaction=[{documents:Array(4).fill(serverTime),query:serverTime+1},
    {documents:Array(4).fill(serverTime+60000),query:serverTime+60217}];
  const original=Date.now;Date.now=()=>{throw Error('WORKSTATION CLOCK MUST NOT BE USED');};
  try {assert.equal((await applyEnrollment(f.input,f.clients)).trialStartMs,serverTime+60217);}
  finally {Date.now=original;}
});
test('succeeded Auth with no trial time resumes from new final reads without another revocation',async()=>{
  const f=fixture();
  f.state.receipt={schemaVersion:1,kind:'strawberry-owner-enrollment-receipt',
    planHashSha256:f.input.planHashSha256,approvalHashSha256:validateApplication(f.input).approvalHashSha256,
    target:structuredClone(f.input.plan.target),state:'firestore-outcome-uncertain',revocation:'succeeded',trialStartMs:null};
  f.state.revocations=1;
  f.state.readTimesByTransaction=[{},
    {documents:Array(4).fill(serverTime+1000),query:serverTime+1217}];
  const result=await applyEnrollment(f.input,f.clients);
  assert.equal(result.trialStartMs,serverTime+1217);assert.equal(f.state.revocations,1);
  assert.equal(f.state.docs.size,4);assert.equal(f.state.receipt.state,'complete');
});
test('missing, nonnumeric, nonfinite and unsafe server time metadata still refuse before writes',async()=>{
  for(const time of [null,0,-1,NaN,Infinity,'1800000000000',Number.MAX_SAFE_INTEGER+1]){
    const f=fixture();f.state.readTimesByTransaction=[{query:time}];
    await assert.rejects(applyEnrollment(f.input,f.clients),/trusted-firestore-read-time/);
    assert.equal(f.state.revocations,0);assert.equal(f.state.docs.size,0);
  }
  const f=fixture();f.state.readTimesByTransaction=[{query:Number.MAX_SAFE_INTEGER}];
  await assert.rejects(applyEnrollment(f.input,f.clients),/invalid-server-time/);
  assert.equal(f.state.revocations,0);assert.equal(f.state.docs.size,0);
});
test('existing docs without original receipt and changed enrollment refuse, never repair/reset',async()=>{
  const f=fixture();f.state.docs.set('tenants/synthetic_tenant',{ownerUid:'synthetic_owner'});
  await assert.rejects(applyEnrollment(f.input,f.clients),/existing-enrollment/);assert.equal(f.state.revocations,0);
  const g=fixture();await applyEnrollment(g.input,g.clients);g.state.docs.get('tenants/synthetic_tenant').trialEndMs++;
  await assert.rejects(applyEnrollment(g.input,g.clients),/existing-enrollment/);assert.equal(g.state.revocations,1);
  const h=fixture();await applyEnrollment(h.input,h.clients);h.state.docs.clear();
  await assert.rejects(applyEnrollment(h.input,h.clients),/completed-enrollment-missing/);assert.equal(h.state.revocations,1);assert.equal(h.state.docs.size,0);
});
test('rechecks owner query in final create transaction to refuse another tenant for same owner',async()=>{
  const f=fixture();f.state.injectPriorOwnerAtCommit=true;
  await assert.rejects(applyEnrollment(f.input,f.clients),/prior-owner/);assert.equal(f.state.docs.size,1);assert.equal(f.state.revocations,1);
});
test('uncertain Auth result stops before documents and never automatically revokes again',async()=>{
  const f=fixture();f.state.failRevoke=true;
  await assert.rejects(applyEnrollment(f.input,f.clients),/auth-revocation-outcome/);
  await assert.rejects(applyEnrollment(f.input,f.clients),/auth-revocation-outcome/);assert.equal(f.state.revocations,1);assert.equal(f.state.docs.size,0);
});
test('lost commit response recovers only exact original docs and time, without repeat revocation',async()=>{
  const f=fixture();f.state.loseCommitResponse=true;
  await assert.rejects(applyEnrollment(f.input,f.clients),/firestore-outcome/);assert.equal(f.state.docs.size,4);
  assert.equal((await applyEnrollment(f.input,f.clients)).status,'already-applied');assert.equal(f.state.revocations,1);
});
test('failed write preserves original server trial time and successful revocation on retry',async()=>{
  const f=fixture();f.state.readTimesByTransaction=[{},
    {documents:Array(4).fill(serverTime+100),query:serverTime+317},
    {documents:Array(4).fill(serverTime+3600000),query:serverTime+3600100},
    {documents:Array(4).fill(serverTime+3600200),query:serverTime+3600417}];
  f.state.failCommit=true;await assert.rejects(applyEnrollment(f.input,f.clients),/firestore-outcome/);
  assert.equal(f.state.docs.size,0);f.state.failCommit=false;
  assert.equal(f.state.receipt.trialStartMs,serverTime+317);
  assert.equal((await applyEnrollment(f.input,f.clients)).trialStartMs,serverTime+317);assert.equal(f.state.revocations,1);
});
test('unverified owner, mismatched client, emulator, absent trusted clock all refuse safely',async()=>{
  const f=fixture();f.clients.auth.getUser=async()=>({uid:'synthetic_owner',email:'owner@example.test',emailVerified:false});await assert.rejects(applyEnrollment(f.input,f.clients),/verified-active/);assert.equal(f.state.revocations,0);
  const g=fixture();g.clients.db.databaseId='other';await assert.rejects(applyEnrollment(g.input,g.clients),/explicit-client/);
  const h=fixture();h.input.environment={FIRESTORE_EMULATOR_HOST:'localhost:8080'};await assert.rejects(applyEnrollment(h.input,h.clients),/invalid-plan/);
  const j=fixture();j.clients.db.runTransaction=async cb=>cb({getAll:async()=>[0,1,2,3].map(()=>({exists:false})),get:async()=>({docs:[]})});await assert.rejects(applyEnrollment(j.input,j.clients),/trusted-firestore/);assert.equal(j.state.revocations,0);
});
test('owner changes during preflight stop before project-wide Auth revocation',async()=>{
  const f=fixture(),run=f.clients.db.runTransaction.bind(f.clients.db);
  f.clients.db.runTransaction=async(callback,options)=>{
    const result=await run(callback,options);
    f.clients.auth.getUser=async()=>({uid:f.input.plan.target.ownerUid,email:f.input.plan.target.expectedEmail,emailVerified:true,disabled:true});
    return result;
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/verified-active-exact-owner/);
  assert.equal(f.state.revocations,0);assert.equal(f.state.docs.size,0);
  assert.equal(f.state.receipt.revocation,'not-started');
});
test('owner email changes after Auth revocation stop before enrollment and retain partial-effect receipt',async()=>{
  const f=fixture(),revoke=f.clients.auth.revokeRefreshTokens;
  f.clients.auth.revokeRefreshTokens=async()=>{
    await revoke();
    f.clients.auth.getUser=async()=>({uid:f.input.plan.target.ownerUid,email:'changed@example.test',emailVerified:true,disabled:false});
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/verified-active-exact-owner/);
  assert.equal(f.state.revocations,1);assert.equal(f.state.docs.size,0);
  assert.equal(f.state.receipt.revocation,'succeeded');
  assert.equal(f.state.receipt.state,'firestore-outcome-uncertain');
});
test('a final-transaction retry rechecks live owner instead of relying on its first attempt',async()=>{
  const f=fixture(),run=f.clients.db.runTransaction.bind(f.clients.db);
  f.clients.db.runTransaction=async(callback,options)=>{
    if(options?.readOnly)return run(callback,options);
    return run(async tx=>{
      await callback(tx); // Aborted first attempt; queued creates have not committed.
      f.clients.auth.getUser=async()=>({uid:f.input.plan.target.ownerUid,email:f.input.plan.target.expectedEmail,emailVerified:false,disabled:false});
      return callback(tx);
    });
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/verified-active-exact-owner/);
  assert.equal(f.state.revocations,1);assert.equal(f.state.docs.size,0);
  assert.equal(f.state.receipt.trialStartMs,serverTime);
});
test('failure to persist successful Auth outcome leaves a conservative receipt and prevents repeated revocation',async()=>{
  const f=fixture(),write=f.clients.receiptStore.write;
  f.clients.receiptStore.write=async value=>{
    if(value.revocation==='succeeded')throw Error('SYNTHETIC RECEIPT IO FAILURE');
    return write(value);
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/RECEIPT IO/);
  assert.equal(f.state.revocations,1);assert.equal(f.state.docs.size,0);
  assert.equal(f.state.receipt.revocation,'requested');
  f.clients.receiptStore.write=write;
  await assert.rejects(applyEnrollment(f.input,f.clients),/auth-revocation-outcome-uncertain/);
  assert.equal(f.state.revocations,1);assert.equal(f.state.docs.size,0);
});
test('failure to save final completion recovers exact committed documents without another trial or revocation',async()=>{
  const f=fixture(),write=f.clients.receiptStore.write;
  f.clients.receiptStore.write=async value=>{
    if(value.state==='complete')throw Error('SYNTHETIC COMPLETION IO FAILURE');
    return write(value);
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/COMPLETION IO/);
  assert.equal(f.state.docs.size,4);assert.equal(f.state.receipt.trialStartMs,serverTime);
  f.clients.receiptStore.write=write;
  assert.equal((await applyEnrollment(f.input,f.clients)).status,'already-applied');
  assert.equal(f.state.revocations,1);assert.equal(f.state.receipt.state,'complete');
});
test('safe failure diagnostics identify final stages without storing provider messages, paths or nested payloads',async()=>{
  for(const expectedStage of ['final-begin','final-owner-check','final-get-all','final-query','final-clock',
    'final-save-trial','final-create-documents','final-commit']){
    const f=fixture(),run=f.clients.db.runTransaction.bind(f.clients.db),write=f.clients.receiptStore.write;
    const secret='SYNTHETIC_PRIVATE_PROVIDER_VALUE';
    const error=Object.assign(new Error(secret+'\n    at '+secret+' (/private/'+secret+':1:2)'),
      {name:'FirebaseAuthError',code:'auth/internal-error',details:{token:secret},response:{body:secret}});
    error.stack=error.name+': '+error.message+'\n    at Transport.request (/private/'+secret+':123:4)\n    at applyEnrollment (/private/operator.mjs:9:2)';
    if(expectedStage==='final-save-trial')f.clients.receiptStore.write=async value=>{
      if(value.state==='firestore-write-requested')throw error;return write(value);
    };
    f.clients.db.runTransaction=async(callback,options)=>{
      if(options?.readOnly)return run(callback,options);
      if(expectedStage==='final-begin')throw error;
      if(expectedStage==='final-owner-check')f.clients.auth.getUser=async()=>{throw error;};
      return run(async tx=>{
        if(expectedStage==='final-get-all')tx.getAll=async()=>{throw error;};
        if(expectedStage==='final-query')tx.get=async()=>{throw error;};
        if(expectedStage==='final-clock'){
          const getAll=tx.getAll;tx.getAll=async(...refs)=>{
            const snapshots=await getAll(...refs);snapshots[0].readTime.toMillis=()=>{throw error;};return snapshots;
          };
        }
        if(expectedStage==='final-create-documents')tx.create=()=>{throw error;};
        const result=await callback(tx);
        if(expectedStage==='final-commit')throw error;
        return result;
      },options);
    };
    await assert.rejects(applyEnrollment(f.input,f.clients),/firestore-outcome-uncertain-after-auth-revocation/);
    const diagnostic=f.state.receipt.lastFailure;
    assert.deepEqual(diagnostic,{stage:expectedStage,errorType:'FirebaseAuthError',code:'auth/internal-error',
      stackFunctions:['Transport.request','applyEnrollment']});
    assert.equal(f.state.receipt.revocation,'succeeded');assert.equal(f.state.revocations,1);
    assert.equal(f.state.docs.size,0);assert.equal(JSON.stringify(f.state.receipt).includes(secret),false);
    assert.equal(JSON.stringify(diagnostic).includes('/private/'),false);
    if(['final-begin','final-owner-check','final-get-all','final-query','final-clock'].includes(expectedStage))
      assert.equal(f.state.receipt.trialStartMs,null);
  }
});
test('diagnostics discard unrecognized error classes/codes and keep only bounded function names',async()=>{
  const f=fixture(),run=f.clients.db.runTransaction.bind(f.clients.db),secret='SYNTHETIC_SECRET_MARKER';
  const error=Object.assign(new Error(secret),{name:secret,code:secret});
  error.stack=error.name+': '+error.message+'\n    at firstFunction (/private/'+secret+':1:2)\n    at /private/'+secret+':3:4\n'+
    Array.from({length:10},(_,i)=>'    at frame'+i+' (/private/'+secret+':4:5)').join('\n');
  f.clients.db.runTransaction=async(callback,options)=>{if(options?.readOnly)return run(callback,options);throw error;};
  await assert.rejects(applyEnrollment(f.input,f.clients),/firestore-outcome-uncertain-after-auth-revocation/);
  assert.equal(f.state.receipt.lastFailure.errorType,'UnknownError');
  assert.equal(f.state.receipt.lastFailure.code,'unclassified');
  assert.equal(f.state.receipt.lastFailure.stackFunctions.length,6);
  assert.equal(JSON.stringify(f.state.receipt).includes(secret),false);
});
test('diagnosed failed recovery preserves succeeded Auth and resumes without another revocation',async()=>{
  const f=fixture(),run=f.clients.db.runTransaction.bind(f.clients.db);
  f.state.receipt={schemaVersion:1,kind:'strawberry-owner-enrollment-receipt',
    planHashSha256:f.input.planHashSha256,approvalHashSha256:validateApplication(f.input).approvalHashSha256,
    target:structuredClone(f.input.plan.target),state:'firestore-outcome-uncertain',revocation:'succeeded',trialStartMs:null};
  f.state.revocations=1;
  f.clients.db.runTransaction=async(callback,options)=>{
    if(options?.readOnly)return run(callback,options);throw Object.assign(new Error('SYNTHETIC FAILURE'),{code:14});
  };
  await assert.rejects(applyEnrollment(f.input,f.clients),/firestore-outcome-uncertain-after-auth-revocation/);
  assert.equal(f.state.receipt.lastFailure.stage,'final-begin');assert.equal(f.state.receipt.lastFailure.code,14);
  assert.equal(f.state.receipt.trialStartMs,null);assert.equal(f.state.revocations,1);
  f.clients.db.runTransaction=run;
  assert.equal((await applyEnrollment(f.input,f.clients)).status,'applied');
  assert.equal(f.state.receipt.state,'complete');assert.equal(f.state.revocations,1);
});
test('CLI rejects missing specific consent before parsing stdin credentials, loading Admin or creating lock files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'strawberry-apply-refusal-'));
  try {
    const f=fixture();f.input.approval.humanApprovalEvidence='';
    const planPath=join(root,'plan.json'),approvalPath=join(root,'approval.json'),receiptPath=join(root,'receipt.json');
    await writeFile(planPath,JSON.stringify(f.input.plan));await writeFile(approvalPath,JSON.stringify(f.input.approval));
    const result=spawnSync(process.execPath,['--permission','--allow-fs-read=*',new URL('./apply-cli.mjs',import.meta.url).pathname,
      '--apply','--credentials-stdin','--project',projectId,'--database',databaseId,'--plan',planPath,
      '--plan-hash',f.input.planHashSha256,'--approval',approvalPath,'--receipt',receiptPath],
    {encoding:'utf8',input:'NOT_CREDENTIAL_JSON; SYNTHETIC TEST INPUT'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/specific-human-approval-required/);
    assert.equal(result.stdout,'');assert.deepEqual((await readdir(root)).sort(),['approval.json','plan.json']);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('production CLI has no default mutation and help loads no cloud SDK or credentials',()=>{
  const cli=new URL('./apply-cli.mjs',import.meta.url);
  const empty=spawnSync(process.execPath,[cli.pathname],{encoding:'utf8'});assert.notEqual(empty.status,0);
  const help=spawnSync(process.execPath,[cli.pathname,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/No default mutation/);
});
