// Explicit, bounded demo-only Auth transport. No SDK retry loop, live endpoint,
// OAuth refresh, arbitrary URL, client injection or production override.
import {DEMO_PROJECT_ID,assertDemoOperatorEnvironment} from './demo-operator.mjs';
const fail=reason=>{throw Error('recovery-authority-transport-'+reason);};
const web=value=>Buffer.from(value).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
function boundary(environment){for(const e of [environment,process.env]){assertDemoOperatorEnvironment(DEMO_PROJECT_ID,e);if(e.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:19199'||e.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:18180'||e.GOOGLE_APPLICATION_CREDENTIALS)fail('demo-boundary');}}
export function createRecoveryAuthorityDemoTransport({environment}){
 boundary(environment);let budget=null,wire=0,requests=0;
 async function request(kind,body){
  boundary(environment);if(!budget)fail('budget-required');budget.check();if(++requests>12_000)fail('request-limit');
  const paths={lookup:'projects/'+DEMO_PROJECT_ID+'/accounts:lookup',create:'accounts:signUp?key=synthetic-recovery-only',import:'projects/'+DEMO_PROJECT_ID+'/accounts:batchCreate'};
  if(!Object.hasOwn(paths,kind))fail('endpoint');const raw=JSON.stringify(body);if(Buffer.byteLength(raw)>65_536)fail('request-byte-limit');
  const remaining=Math.floor(budget.remaining());if(remaining<=0)fail('deadline');const signal=AbortSignal.timeout(Math.min(10_000,remaining));let response;
  try{response=await fetch('http://127.0.0.1:19199/identitytoolkit.googleapis.com/v1/'+paths[kind],{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:raw,redirect:'error',signal});}catch{fail('request-ambiguous');}
  if(!response.body)fail('response');const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;wire+=value.length;if(size>1_048_576||wire>32*1024*1024)fail('response-byte-limit');chunks.push(Buffer.from(value));budget.check();}}
  catch{fail('response-ambiguous');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!response.ok){const e=Error('recovery-authority-transport-rejected');e.definitiveAuthRejection=true;throw e;}
  budget.check();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('response-json');}if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail('response-schema');return value;
 }
 async function lookup(selector){
  const value=await request('lookup',selector);if(!Array.isArray(value.users??[])||(value.users??[]).length>1)fail('lookup-cardinality');if(!value.users?.length)return null;const u=value.users[0];
  let claims={};try{if(u.customAttributes!==undefined)claims=JSON.parse(u.customAttributes);}catch{fail('claims');}if(!claims||Object.getPrototypeOf(claims)!==Object.prototype)fail('claims');
  if(typeof u.localId!=='string'||!Array.isArray(u.providerUserInfo??[])||(u.providerUserInfo??[]).length>20||!Array.isArray(u.mfaInfo??[])||(u.mfaInfo??[]).length>10)fail('user-schema');
  return {uid:u.localId,email:u.email,emailVerified:u.emailVerified===true,disabled:u.disabled===true,displayName:u.displayName,photoURL:u.photoUrl,passwordHash:u.passwordHash,passwordSalt:u.salt,phoneNumber:u.phoneNumber,mfaInfo:u.mfaInfo??[],customClaims:claims,providerData:(u.providerUserInfo??[]).map(p=>({providerId:p.providerId}))};
 }
 return Object.freeze({
  setBudget(value){budget=value;wire=0;requests=0;},
  getUser(uid){return lookup({localId:[uid]});},
  getUserByEmail(email){return lookup({email:[email]});},
  async createUser(u){if(u.disabled!==true||u.emailVerified!==false||u.password!==undefined)fail('disabled-reservation-required');const v=await request('create',{targetProjectId:DEMO_PROJECT_ID,localId:u.uid,email:u.email,emailVerified:false,displayName:u.displayName,disabled:true});if(v.localId!==u.uid)fail('reservation-response');},
  async importUsers(users,{hash}){
   if(users.length!==1||users[0].disabled!==true||Object.keys(users[0].customClaims??{}).length)fail('disabled-owned-import-required');const u=users[0],record={localId:u.uid,email:u.email,emailVerified:u.emailVerified,disabled:true,displayName:u.displayName,customAttributes:'{}',providerUserInfo:[],mfaInfo:[],passwordHash:web(u.passwordHash),salt:web(u.passwordSalt)};
   if(u.photoURL)record.photoUrl=u.photoURL;if(u.metadata?.creationTime)record.createdAt=String(Date.parse(u.metadata.creationTime));if(u.metadata?.lastSignInTime)record.lastLoginAt=String(Date.parse(u.metadata.lastSignInTime));
   const value=await request('import',{hashAlgorithm:'SCRYPT',signerKey:web(hash.key),saltSeparator:web(hash.saltSeparator),rounds:hash.rounds,memoryCost:hash.memoryCost,users:[record],sanityCheck:true,allowOverwrite:true});
   if(!Array.isArray(value.error??[])||(value.error??[]).length>1||(value.error??[]).some(e=>e.index!==0))fail('import-result');const errors=value.error??[];return {successCount:1-errors.length,failureCount:errors.length,errors:errors.map(e=>({index:e.index}))};
  },
 });
}
