// No production override. Auth imports can replace UIDs, so every import below
// requires a separately created, disabled, journal-owned reservation first.
import {randomBytes} from 'node:crypto';
import {createPrivateKey} from 'node:crypto';
import {initializeApp,deleteApp,cert} from 'firebase-admin/app';
import {initializeFirestore} from 'firebase-admin/firestore';
import {emulatorFirestoreSettings} from '../worker/emulator-firestore-auth.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from './demo-operator.mjs';
import {decodeRecoveryFields} from './firestore-recovery-source.mjs';
import {canonical,integer} from './validation.mjs';
import {openRecoveryAuthorityPackage,authorityDigest,AUTHORITY_RECOVERY_LIMITS as L} from './recovery-authority-package.mjs';
import {createRecoveryAuthorityDemoTransport} from './recovery-authority-transport.mjs';
const targets=new WeakMap(),busy=new WeakSet(),fail=reason=>{throw Error('recovery-authority-demo-'+reason);};
function boundary(environment){
 for(const e of [environment,process.env]){assertDemoOperatorEnvironment(DEMO_PROJECT_ID,e);if(e.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18180'||e.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:19199')fail('dedicated-emulators-required');}
 for(const key of ['GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST'])if(environment[key]!==process.env[key])fail('environment-mismatch');
 if(environment.GOOGLE_APPLICATION_CREDENTIALS)fail('ambient-credential');
}
export function createRecoveryAuthorityDemoTarget({credential,environment=process.env}){
 boundary(environment);
 if(!credential||Object.getPrototypeOf(credential)!==Object.prototype||Object.keys(credential).some(k=>!['project_id','client_email','private_key'].includes(k))||credential.project_id!==DEMO_PROJECT_ID||typeof credential.client_email!=='string'||!new RegExp('^[a-z][a-z0-9-]{0,62}@'+DEMO_PROJECT_ID+'\\.iam\\.gserviceaccount\\.com$').test(credential.client_email)||typeof credential.private_key!=='string'||credential.private_key.length>8192)fail('explicit-demo-credential-required');
 try{const key=createPrivateKey(credential.private_key);if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)fail('credential-key');}catch{fail('credential-key');}
 const app=initializeApp({projectId:DEMO_PROJECT_ID,credential:cert(credential)},'authority-recovery-'+randomBytes(12).toString('hex'));
 const db=initializeFirestore(app,{preferRest:true});db.settings({host:'127.0.0.1:18180',ssl:false,...emulatorFirestoreSettings(DEMO_PROJECT_ID,environment)});const auth=createRecoveryAuthorityDemoTransport({environment});
 let closed=false;const target=Object.freeze({kind:'demo-only-disabled-authority-recovery',projectId:DEMO_PROJECT_ID,async close(){if(!closed){if(busy.has(target))fail('target-busy');closed=true;await deleteApp(app);targets.delete(target);}}});
 targets.set(target,{db,auth,environment,check(){boundary(environment);const settings=db._settings,local=settings.host==='127.0.0.1:18180'||settings.servicePath==='127.0.0.1'&&settings.port===18180;if(closed||db.projectId!==DEMO_PROJECT_ID||db.databaseId!=='(default)'||!local||settings.ssl!==false||app.options.projectId!==DEMO_PROJECT_ID)fail('target-boundary');}});return target;
}
function importedValue(u){
 const out={uid:u.localId,email:u.email,emailVerified:u.emailVerified,disabled:true,displayName:u.displayName??'',customClaims:{},passwordHash:Buffer.from(u.passwordHash,'base64'),passwordSalt:Buffer.from(u.salt,'base64')};
 if(u.photoUrl)out.photoURL=u.photoUrl;
 if(u.createdAt!==undefined||u.lastSignedInAt!==undefined){out.metadata={};if(u.createdAt!==undefined)out.metadata.creationTime=new Date(Number(u.createdAt)).toISOString();if(u.lastSignedInAt!==undefined)out.metadata.lastSignInTime=new Date(Number(u.lastSignedInAt)).toISOString();}
 return out;
}
function equalHash(raw,wanted){if(typeof raw!=='string')return false;return Buffer.from(raw,'base64').equals(Buffer.from(wanted,'base64'));}
function isImported(user,u){return user?.uid===u.localId&&user.email?.toLowerCase()===u.email.toLowerCase()&&user.emailVerified===u.emailVerified&&user.disabled===true&&!user.phoneNumber&&!(user.mfaInfo??[]).length&&(user.displayName??'')===(u.displayName??'')&&(user.photoURL??'')===(u.photoUrl??'')&&Object.keys(user.customClaims??{}).length===0&&(user.providerData??[]).every(p=>p.providerId==='password')&&equalHash(user.passwordHash,u.passwordHash)&&equalHash(user.passwordSalt,u.salt);}
function isReservation(user,u,j){return user?.uid===u.localId&&user.email?.toLowerCase()===u.email.toLowerCase()&&user.emailVerified===false&&user.disabled===true&&user.displayName===j.marker&&!user.passwordHash&&!user.passwordSalt&&!user.photoURL&&!user.phoneNumber&&!(user.mfaInfo??[]).length&&Object.keys(user.customClaims??{}).length===0&&(user.providerData??[]).every(p=>p.providerId==='password');}
function userJournal(j,uid,digest,packageSha256){if(!j||Object.keys(j).sort().join('|')!==['format','uid','sourceSha256','packageSha256','marker','state'].sort().join('|')||j.format!=='disabled-auth-recovery-user-v1'||j.uid!==uid||j.sourceSha256!==digest||j.packageSha256!==packageSha256||!/^__recovery_reservation__[a-f0-9]{48}$/.test(j.marker)||!['planned','reserved','verified'].includes(j.state))fail('user-journal');}
function journalValid(j,packageSha256,contextSha256){return j&&Object.keys(j).sort().join('|')===['format','packageSha256','contextSha256','enabled','activationAllowed','state','owner','leaseUntilMs'].sort().join('|')&&j.format==='disabled-authority-recovery-v1'&&j.packageSha256===packageSha256&&j.contextSha256===contextSha256&&j.enabled===false&&j.activationAllowed===false&&['staging','verified_quarantine'].includes(j.state)&&typeof j.owner==='string'&&/^(?:[a-f0-9]{48})?$/.test(j.owner)&&Number.isSafeInteger(j.leaseUntilMs)&&j.leaseUntilMs>=0;}
async function getOptional(auth,method,value){try{return await auth[method](value);}catch(e){if(e.code==='auth/user-not-found')return null;fail('auth-read');}}

export async function restoreRecoveryAuthorityDemo({target,envelope,masterKey,expected,maxUsers=1000,maxOperatorRecords=5000,maxRuntimeMs=600_000,afterReservation=async()=>{},afterImport=async()=>{},afterUserCommit=async()=>{}}){
 const handle=targets.get(target);if(!handle)fail('owned-target-required');handle.check();if(busy.has(target))fail('target-busy');integer(maxUsers,1,L.users);integer(maxOperatorRecords,1,L.operatorRecords);integer(maxRuntimeMs,1,1_800_000);
 if([afterReservation,afterImport,afterUserCommit].some(f=>typeof f!=='function'))fail('hook');
 const started=performance.now(),p=openRecoveryAuthorityPackage({envelope,masterKey,expected}),packageSha256=authorityDigest(envelope),contextSha256=authorityDigest(p.context),owner=randomBytes(24).toString('hex');
 const {auth,db}=handle,root=db.doc('authorityRecoveryQuarantine/'+p.context.imageId);let usersDone=0,operatorsDone=0,newUsers=0,newOperators=0,leaseAcquired=false,uncertainAuthWrite=false,leaseUntilMs=0;
 function check(){handle.check();if(performance.now()-started>=maxRuntimeMs)fail('runtime-limit');if(leaseAcquired&&Date.now()>=leaseUntilMs)fail('lease-local-deadline');}
 auth.setBudget({check,remaining:()=>maxRuntimeMs-(performance.now()-started)});
 async function current(tx){check();const s=await tx.get(root),j=s.data();check();if(!journalValid(j,packageSha256,contextSha256)||j.owner!==owner||j.leaseUntilMs<s.readTime.toMillis())fail('lease-or-context');return j;}
 async function fence(){await db.runTransaction(async tx=>{await current(tx);},{maxAttempts:1});}
 busy.add(target);
 try{
  // Read-only complete preflight: a collision anywhere prevents importing even
  // the first absent user. Owned journals are verified again during execution.
  for(const u of p.users){check();const ref=root.collection('authUsers').doc(u.localId),j=(await ref.get()).data();if(j)userJournal(j,u.localId,authorityDigest(u),packageSha256);
   const found=await getOptional(auth,'getUser',u.localId),email=await getOptional(auth,'getUserByEmail',u.email);
   if(email&&email.uid!==u.localId||found&&!j||found&&j&&!isReservation(found,u,j)&&!isImported(found,u)||j?.state==='verified'&&!isImported(found,u))fail('existing-user-collision');
  }
  await db.runTransaction(async tx=>{
   check();const s=await tx.get(root),old=s.data(),time=s.readTime.toMillis();check();
   if(old&&(!journalValid(old,packageSha256,contextSha256)||old.owner&&old.leaseUntilMs>time))fail('journal-or-active-lease');
   leaseUntilMs=time+maxRuntimeMs+30_000;const value={format:'disabled-authority-recovery-v1',packageSha256,contextSha256,enabled:false,activationAllowed:false,state:'staging',owner,leaseUntilMs};
   if(old)tx.set(root,value);else tx.create(root,value);
  },{maxAttempts:1});leaseAcquired=true;
  for(const u of p.users){
   check();const ref=root.collection('authUsers').doc(u.localId),digest=authorityDigest(u);let j=(await ref.get()).data();
   if(j)userJournal(j,u.localId,digest,packageSha256);const wasVerified=j?.state==='verified';
   if(!j){j={format:'disabled-auth-recovery-user-v1',uid:u.localId,sourceSha256:digest,packageSha256,marker:'__recovery_reservation__'+randomBytes(24).toString('hex'),state:'planned'};await db.runTransaction(async tx=>{await current(tx);const old=await tx.get(ref);check();if(old.exists)fail('user-journal-changed');tx.create(ref,j);},{maxAttempts:1});}
   let found=await getOptional(auth,'getUser',u.localId);
   if(!found){if(j.state!=='planned')fail('owned-user-missing');await fence();check();uncertainAuthWrite=true;try{await auth.createUser({uid:u.localId,email:u.email,emailVerified:false,displayName:j.marker,disabled:true});uncertainAuthWrite=false;}catch(e){if(e.definitiveAuthRejection)uncertainAuthWrite=false;fail('reservation-create');}await afterReservation({users:usersDone+1});found=await getOptional(auth,'getUser',u.localId);}
   if(isImported(found,u)){
    if(j.state==='planned')fail('unproven-import-ownership');
   }else{
    if(j.state==='verified'||!isReservation(found,u,j))fail('reservation-integrity');
    if(j.state==='planned'){await db.runTransaction(async tx=>{await current(tx);const old=(await tx.get(ref)).data();check();if(canonical(old)!==canonical(j))fail('user-journal-changed');tx.update(ref,{state:'reserved'});},{maxAttempts:1});j={...j,state:'reserved'};}
    await fence();const again=await getOptional(auth,'getUser',u.localId);check();if(!isReservation(again,u,j))fail('reservation-integrity');await fence();check();
    const value=importedValue(u),hash={algorithm:p.hash.algorithm,key:Buffer.from(p.hash.key,'base64'),saltSeparator:Buffer.from(p.hash.saltSeparator,'base64'),rounds:p.hash.rounds,memoryCost:p.hash.memoryCost};let result;
    uncertainAuthWrite=true;try{result=await auth.importUsers([value],{hash});uncertainAuthWrite=false;}catch(e){if(e.definitiveAuthRejection)uncertainAuthWrite=false;fail('auth-import-ambiguous');}finally{value.passwordHash.fill(0);value.passwordSalt.fill(0);hash.key.fill(0);hash.saltSeparator.fill(0);}
    await afterImport({users:usersDone+1});
    if(result.successCount!==1||result.failureCount!==0||result.errors?.length)fail('auth-import-partial');
   }
   await fence();if(!isImported(await getOptional(auth,'getUser',u.localId),u))fail('import-verification');
   if(j.state!=='verified')await db.runTransaction(async tx=>{await current(tx);const old=(await tx.get(ref)).data();check();if(canonical(old)!==canonical(j))fail('user-journal-changed');tx.update(ref,{state:'verified'});},{maxAttempts:1});
   usersDone++;if(!wasVerified)newUsers++;await afterUserCommit({users:usersDone});if(newUsers>=maxUsers&&usersDone<p.users.length)return result('staging',true);
  }
  for(const row of p.operatorRecords){
   check();const ref=root.collection('operatorRecords').doc(authorityDigest(row.path)),value={format:'disabled-operator-history-v1',enabled:false,activationAllowed:false,sourcePath:row.path,sourceProjectId:p.context.projectId,sourceTenantId:p.context.tenantId,packageSha256,sourceSha256:authorityDigest(row),payload:row.payload};
   const created=await db.runTransaction(async tx=>{await current(tx);const s=await tx.get(ref);check();if(s.exists){if(canonical(s.data())!==canonical(value))fail('operator-collision');return false;}tx.create(ref,value);return true;},{maxAttempts:1});operatorsDone++;if(created)newOperators++;
   if(newOperators>=maxOperatorRecords&&operatorsDone<p.operatorRecords.length)return result('staging',true);
  }
  await verifyInventory({root,p,packageSha256,check});
  for(const u of p.users){check();if(!isImported(await getOptional(auth,'getUser',u.localId),u))fail('import-verification');}
  await db.runTransaction(async tx=>{await current(tx);tx.update(root,{state:'verified_quarantine'});},{maxAttempts:1});return result('verified_quarantine',false);
 }finally{
  try{if(leaseAcquired&&!uncertainAuthWrite)await db.runTransaction(async tx=>{const s=await tx.get(root),j=s.data();if(j?.owner===owner)tx.update(root,{owner:'',leaseUntilMs:0});},{maxAttempts:1});}finally{auth.setBudget(null);busy.delete(target);}
 }
 function result(state,budgetExhausted){return {format:'disabled-authority-recovery-result-v1',state,packageSha256,contextSha256,users:usersDone,operatorRecords:operatorsDone,budgetExhausted,enabled:false,activationAllowed:false,productionRecoveryAccepted:false,passwordHashBytesVerified:state==='verified_quarantine',sessionsRestored:false,customClaimsActivated:false};}
}

// SDK queries omit missing parents with descendants. Bounded showMissing REST
// inventory detects orphan and nested quarantine documents before acceptance.
async function verifyInventory({root,p,packageSha256,check}){
 let wireBytes=0,requests=0;
 async function request(path,{body,query={}}={}){
  check();if(++requests>2*(L.users+L.operatorRecords)+1000)fail('inventory-request-limit');const url=new URL('http://127.0.0.1:18180/v1/projects/'+DEMO_PROJECT_ID+'/databases/(default)/documents/'+path);if(!body)url.search=new URLSearchParams(query).toString();
  const response=await fetch(url,{method:body?'POST':'GET',headers:{authorization:'Bearer owner',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail('inventory-http');}const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;wireBytes+=value.length;if(size>1_048_576||wireBytes>32*1024*1024)fail('inventory-byte-limit');chunks.push(Buffer.from(value));check();}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('inventory-json');}
 }
 async function children(path){const value=await request(path+':listCollectionIds',{body:{pageSize:3}});if(value.nextPageToken||!Array.isArray(value.collectionIds??[])||(value.collectionIds??[]).length>2)fail('target-inventory');return (value.collectionIds??[]).sort();}
 if(canonical(await children(root.path))!==canonical(['authUsers',...(p.operatorRecords.length?['operatorRecords']:[])].sort()))fail('target-inventory');
 const users=new Map(p.users.map(u=>[u.localId,u])),operators=new Map(p.operatorRecords.map(row=>[authorityDigest(row.path),row]));
 for(const [collection,expected]of [['authUsers',users],['operatorRecords',operators]]){
  let token='',last='',count=0,pages=0;
  do{check();if(++pages>expected.size+1)fail('inventory-page-limit');const value=await request(root.path+'/'+collection,{query:{pageSize:'20',showMissing:'true',...(token?{pageToken:token}:{})}});
   if(!Array.isArray(value.documents??[])||(value.documents??[]).length>20)fail('target-inventory');
   for(const doc of value.documents??[]){const prefix='projects/'+DEMO_PROJECT_ID+'/databases/(default)/documents/'+root.path+'/'+collection+'/';if(typeof doc.name!=='string'||!doc.name.startsWith(prefix)||!doc.createTime||!doc.updateTime)fail('target-inventory');const name=doc.name.slice(prefix.length),wanted=expected.get(name);if(!wanted||name<=last||++count>expected.size||(await children(root.path+'/'+collection+'/'+name)).length)fail('target-inventory');last=name;const row=decodeRecoveryFields(doc.fields??{});
    if(collection==='authUsers'){userJournal(row,name,authorityDigest(wanted),packageSha256);if(row.state!=='verified')fail('target-inventory');}
    else{const correct={format:'disabled-operator-history-v1',enabled:false,activationAllowed:false,sourcePath:wanted.path,sourceProjectId:p.context.projectId,sourceTenantId:p.context.tenantId,packageSha256,sourceSha256:authorityDigest(wanted),payload:wanted.payload};if(canonical(row)!==canonical(correct))fail('target-inventory');}
   }
   const next=value.nextPageToken??'';if(typeof next!=='string'||next.length>4096||next&&next===token||next&&!(value.documents??[]).length)fail('inventory-token');token=next;
  }while(token);if(count!==expected.size)fail('target-inventory');
 }
}
