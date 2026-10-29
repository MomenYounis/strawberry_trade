import {createHash} from 'node:crypto';
import {createEnrollmentPlan} from './plan.mjs';

const fail = code => {throw new EnrollmentApplyError(code);};
export class EnrollmentApplyError extends Error {constructor(code) {super(code);this.code=code;}}
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (a,b) => canonical(a)===canonical(b);
const diagnosticTypes=new Set(['Error','TypeError','RangeError','ReferenceError','SyntaxError','EvalError','URIError',
  'AssertionError','FirebaseError','FirebaseAuthError','GoogleError','GrpcError','EnrollmentApplyError']);
const diagnosticStages=new Set(['final-begin','final-owner-check','final-get-all','final-query','final-validate',
  'final-clock','final-save-trial','final-validate-trial','final-create-documents','final-commit']);
const diagnosticCodes=new Set(['EIO','ENOENT','EACCES','EPERM','EEXIST','EINVAL','ETIMEDOUT','ENOTFOUND',
  'ECONNRESET','ECONNREFUSED','EPIPE','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP2_STREAM_CANCEL',
  'auth/internal-error','auth/network-request-failed','auth/user-not-found','auth/insufficient-permission',
  'auth/invalid-credential','auth/invalid-argument','auth/project-not-found']);
function failureDiagnostic(error,stage) {
  const diagnostic={stage:diagnosticStages.has(stage)?stage:'unclassified',errorType:'UnknownError',code:'unclassified',stackFunctions:[]};
  try {
    if(diagnosticTypes.has(error?.name))diagnostic.errorType=error.name;
    if(Number.isInteger(error?.code)&&error.code>=0&&error.code<=599)diagnostic.code=error.code;
    else if(diagnosticCodes.has(error?.code))diagnostic.code=error.code;
    else if(error instanceof EnrollmentApplyError&&/^[a-z][a-z-]{0,79}$/.test(error.code||''))diagnostic.code=error.code;
    if(typeof error?.stack==='string') {
      // Remove the complete possibly multiline error header; never retain the
      // message, file paths, line numbers, provider payload or nested causes.
      const headerLines=String(error.message||'').split('\n').length+String(error.name||'').split('\n').length-1;
      for(const line of error.stack.split('\n').slice(headerLines)) {
        const match=/^\s+at (?:async )?(?:new )?([A-Za-z_$][A-Za-z0-9_$.]{0,79}) \(/.exec(line);
        if(match&&!diagnostic.stackFunctions.includes(match[1]))diagnostic.stackFunctions.push(match[1]);
        if(diagnostic.stackFunctions.length===6)break;
      }
    }
  } catch {} // Diagnostics must not replace or expose the original failure.
  return diagnostic;
}
const confirmations = ['manualOwnerAndPhysicalPhoneKeyHandoffConfirmed',
  'priorBusinessEnrollmentAndTrialHistoryChecked', 'noPriorBusinessEnrollmentFound',
  'liveGatewayAppCheckRulesAndIndexReviewCompleted',
  'projectWideOwnerSessionRevocationAcknowledged', 'createOnlyEnrollmentAndThirtyDayTrialApproved'];

/** Pure gate. An approval file records an actual human instruction; it cannot manufacture consent. */
export function validateApplication({plan,approval,projectId,databaseId,planHashSha256,environment={}}) {
  let rebuilt;
  try {rebuilt=createEnrollmentPlan(plan?.target,{projectId,databaseId,environment});}
  catch {fail('invalid-plan-or-target');}
  if (!/^[a-f0-9]{64}$/.test(planHashSha256||'') || rebuilt.planHashSha256!==planHashSha256 || !equal(rebuilt,plan)) fail('plan-content-or-hash-mismatch');
  if (!approval || approval.schemaVersion!==1 || approval.kind!=='strawberry-owner-enrollment-approval' ||
      approval.projectId!==projectId || approval.databaseId!==databaseId ||
      approval.planHashSha256!==planHashSha256 || !equal(approval.target,plan.target) ||
      approval.publicKeySha256Hex!==plan.publicKeySha256Hex ||
      typeof approval.humanApprovalEvidence!=='string' || approval.humanApprovalEvidence.trim().length<20 ||
      approval.humanApprovalEvidence.length>4096 || confirmations.some(key=>approval[key]!==true)) fail('specific-human-approval-required');
  return {target:structuredClone(plan.target),approvalHashSha256:sha(approval)};
}

function documents(plan,start) {
  return plan.proposedActions[1].documents.map(item=>({path:item.path,data:Object.fromEntries(
    Object.entries(item.data).map(([key,value])=>[key,value==='SERVER_TIME_MS'?start:
      value==='SERVER_TIME_MS + 2592000000'?start+2592000000:value]))}));
}
function trustedReadTime(snapshots,query) {
  const times=[...snapshots,query].map(s=>s.readTime?.toMillis?.());
  if (times.some(t=>!Number.isFinite(t)||t<=0||!Number.isSafeInteger(Math.floor(t)))) fail('trusted-firestore-read-time-required');
  // BatchGet/RunQuery read metadata need not match. Transaction isolation is
  // enforced by Firestore; use the latest server read as this attempt's clock.
  // https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet
  const time=Math.floor(Math.max(...times));
  if (time<=0||!Number.isSafeInteger(time+2592000000)) fail('invalid-server-time');
  return time;
}

/** Explicitly injected production clients and durable receipt storage; importing never discovers credentials. */
export async function applyEnrollment(input,{db,auth,receiptStore}) {
  const {plan,projectId,databaseId,planHashSha256}=input;
  const checked=validateApplication(input),target=checked.target;
  if (db?.projectId!==projectId || db?.databaseId!==databaseId || auth?.app?.options?.projectId!==projectId ||
      typeof receiptStore?.read!=='function'||typeof receiptStore?.write!=='function') fail('explicit-client-or-receipt-required');
  let receipt=await receiptStore.read();
  if (receipt && (receipt.schemaVersion!==1 || receipt.kind!=='strawberry-owner-enrollment-receipt' ||
      receipt.planHashSha256!==planHashSha256 || receipt.approvalHashSha256!==checked.approvalHashSha256 ||
      !equal(receipt.target,target))) fail('receipt-mismatch');
  const assertLiveOwner=async()=>{
    const user=await auth.getUser(target.ownerUid);
    if (user.uid!==target.ownerUid || user.email!==target.expectedEmail || user.emailVerified!==true || user.disabled===true) fail('verified-active-exact-owner-required');
  };
  await assertLiveOwner();
  const refs=plan.proposedActions[1].documents.map(item=>db.doc(item.path));
  let stage='preflight';
  const inspect=async(tx,prefix='preflight')=>{
    stage=prefix+'-get-all';
    const snapshots=await tx.getAll(...refs);
    stage=prefix+'-query';
    const query=await tx.get(db.collection('tenants').where('ownerUid','==',target.ownerUid).limit(2));
    stage=prefix+'-validate';
    if (query.docs.some(s=>s.id!==target.tenantId)) fail('prior-owner-enrollment-found');
    const any=snapshots.some(s=>s.exists);
    if (any) {
      if (!receipt || receipt.revocation!=='succeeded' || !Number.isSafeInteger(receipt.trialStartMs) ||
          !snapshots.every(s=>s.exists) || query.docs.length!==1) fail('existing-enrollment-refused');
      const expected=documents(plan,receipt.trialStartMs);
      if (snapshots.some((s,i)=>!equal(s.data(),expected[i].data))) fail('existing-enrollment-refused');
      return {exists:true};
    }
    if (query.docs.length) fail('prior-owner-enrollment-found');
    stage=prefix+'-clock';
    return {exists:false,serverTimeMs:trustedReadTime(snapshots,query)};
  };
  const preflight=await db.runTransaction(inspect,{readOnly:true});
  if (preflight.exists) {
    receipt.state='complete';await receiptStore.write(receipt);
    return {status:'already-applied',planHashSha256,tenantId:target.tenantId,trialStartMs:receipt.trialStartMs,trialEndMs:receipt.trialStartMs+2592000000};
  }
  if (receipt?.state==='complete') fail('completed-enrollment-missing-refused');
  if (!receipt) {
    receipt={schemaVersion:1,kind:'strawberry-owner-enrollment-receipt',planHashSha256,
      approvalHashSha256:checked.approvalHashSha256,target,state:'ready',revocation:'not-started',trialStartMs:null};
    await receiptStore.write(receipt);
  }
  // A lost Auth response can mean revocation succeeded. Never silently repeat it.
  if (!['not-started','succeeded'].includes(receipt.revocation)) fail('auth-revocation-outcome-uncertain');
  if (receipt.revocation==='not-started') {
    await assertLiveOwner(); // Preflight/local storage may have taken time; revoke only the still-approved account.
    receipt.revocation='requested';receipt.state='auth-revocation-requested';await receiptStore.write(receipt);
    try {await auth.revokeRefreshTokens(target.ownerUid);}
    catch {receipt.revocation='uncertain';receipt.state='auth-revocation-outcome-uncertain';await receiptStore.write(receipt);fail('auth-revocation-outcome-uncertain');}
    receipt.revocation='succeeded';receipt.state='auth-revoked';await receiptStore.write(receipt);
  }
  try {
    stage='final-begin';
    await db.runTransaction(async tx=>{
      stage='final-owner-check';
      await assertLiveOwner(); // Repeat on each Firestore transaction retry, after any successful revocation.
      const state=await inspect(tx,'final'); // Owner query and all four preconditions share this transaction.
      if (state.exists) {stage='final-commit';return;}
      if (receipt.trialStartMs===null) {
        receipt.trialStartMs=state.serverTimeMs;receipt.state='firestore-write-requested';
        stage='final-save-trial';await receiptStore.write(receipt);
      }
      stage='final-validate-trial';
      if (!Number.isSafeInteger(receipt.trialStartMs)||receipt.trialStartMs<=0) fail('invalid-original-trial-time');
      stage='final-create-documents';
      for (const item of documents(plan,receipt.trialStartMs)) tx.create(db.doc(item.path),item.data);
      stage='final-commit';
    });
  } catch (error) {
    receipt.lastFailure=failureDiagnostic(error,stage);
    receipt.state='firestore-outcome-uncertain';await receiptStore.write(receipt);
    if (error instanceof EnrollmentApplyError) throw error;
    fail('firestore-outcome-uncertain-after-auth-revocation');
  }
  receipt.state='complete';await receiptStore.write(receipt);
  return {status:'applied',planHashSha256,tenantId:target.tenantId,trialStartMs:receipt.trialStartMs,trialEndMs:receipt.trialStartMs+2592000000};
}

export const requiredApprovalConfirmations=Object.freeze([...confirmations]);
