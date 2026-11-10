// Portable supplied Auth/operator evidence. No credential discovery or I/O.
import {createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';

export const AUTHORITY_RECOVERY_LIMITS=Object.freeze({users:1000,operatorRecords:5000,recordBytes:24_576,plainBytes:8_388_608,envelopeBytes:11_186_176,depth:20,nodes:100_000,tokens:400_000});
export const AUTHORITY_OPERATOR_COLLECTIONS=Object.freeze(['adminDeletions','adminEnrollmentHistory','adminOperations','adminTenantHistory']);
const L=AUTHORITY_RECOVERY_LIMITS,hex=/^[a-f0-9]{64}$/,fail=reason=>{throw Error('recovery-authority-'+reason);};
export const authorityDigest=value=>createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonical(value)).digest('hex');
const bytes=value=>Buffer.from(canonical(value));
function object(v){if(!v||Object.getPrototypeOf(v)!==Object.prototype)fail('schema');}
function keys(v,required,optional=[]){object(v);if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail('schema');}
function text(v,max,empty=false){if(typeof v!=='string'||v.length>max||!v.isWellFormed()||(!empty&&!v)||/[\x00-\x1f\x7f]/.test(v))fail('text');return v;}
function json(v,depth=0,stringLimit=L.recordBytes){if(depth>L.depth)fail('depth');if(v===null||typeof v==='boolean')return;if(typeof v==='string'){if(!v.isWellFormed()||Buffer.byteLength(v)>stringLimit)fail('string-limit');return;}if(typeof v==='number'){if(!Number.isSafeInteger(v))fail('number');return;}if(!Array.isArray(v))object(v);for(const [k,c]of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))fail('property');json(c,depth+1,stringLimit);}}
// JSON.parse alone silently accepts duplicate keys. Token validation also bounds
// depth and rejects duplicates, including differently escaped equivalent keys.
function parse(input,max,{canonicalOnly=false,stringLimit=L.recordBytes}={}){
 if(!(input instanceof Uint8Array)||input.byteLength>max)fail('byte-limit');let raw,value;
 try{raw=new TextDecoder('utf-8',{fatal:true}).decode(input);}catch{fail('json');}
 const token=/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/gy,stack=[];let pos=0,nodes=0,tokens=0;
 while(pos<raw.length){let t;const start=pos,ch=raw[pos];if(ch===' '||ch==='\n'||ch==='\r'||ch==='\t'){pos++;continue;}
  // Scan quoted text iteratively. A regex with a repeated string-alternative
  // can consume the engine's backtracking stack on multi-megabyte ciphertext.
  if(ch==='"'){pos++;let closed=false;while(pos<raw.length){const c=raw[pos++];if(c==='"'){closed=true;break;}if(c.charCodeAt(0)<32)fail('json');if(c==='\\'){const escape=raw[pos++];if(escape==='u'){if(!/^[0-9a-fA-F]{4}$/.test(raw.slice(pos,pos+4)))fail('json');pos+=4;}else if(!'"\\/bfnrt'.includes(escape??'!'))fail('json');}if(pos-start>6*stringLimit+2)fail('string-limit');}if(!closed)fail('json');t=raw.slice(start,pos);}
  else if('{}[]:,'.includes(ch)){t=ch;pos++;}
  else{token.lastIndex=pos;const match=token.exec(raw);if(!match)fail('json');t=match[0];pos=token.lastIndex;}
  if(++tokens>L.tokens)fail('token-limit');if(!['}',']',':',','].includes(t)&&++nodes>L.nodes)fail('node-limit');
  if(t[0]==='"'&&Buffer.byteLength(t)>6*stringLimit+2)fail('string-limit');
  const top=stack.at(-1);if(t[0]==='"'&&top?.object&&top.key){const k=JSON.parse(t);if(top.keys.has(k))fail('duplicate-property');top.keys.add(k);top.key=false;}
  if(t==='{'||t==='['){stack.push({object:t==='{',key:t==='{',keys:new Set()});if(stack.length>L.depth)fail('depth');}
  else if(t==='}'||t===']'){if(!top||top.object!==(t==='}'))fail('json');stack.pop();}else if(t===','&&top?.object)top.key=true;
 }
 if(stack.length)fail('json');try{value=JSON.parse(raw);}catch{fail('json');}
 json(value,0,stringLimit);if(canonicalOnly&&canonical(value)!==raw)fail('noncanonical');return value;
}
function base64(value,min,max){text(value,Math.ceil(max/3)*4,true);if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('base64');const b=Buffer.from(value,'base64');if(b.length<min||b.length>max||b.toString('base64')!==value)fail('base64');return b;}
function context(c){keys(c,['projectId','databaseId','tenantId','readTime','imageId','imageManifestSha256','keyId']);if(typeof c.projectId!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(c.projectId)||c.databaseId!=='(default)')fail('context');for(const k of ['tenantId','imageId','keyId'])id(c[k]);if(!hex.test(c.imageManifestSha256)||typeof c.readTime!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(c.readTime)||!Number.isFinite(Date.parse(c.readTime))||new Date(Date.parse(c.readTime)).toISOString().slice(0,19)!==c.readTime.slice(0,19))fail('context');}
function hashOptions(h){keys(h,['algorithm','key','saltSeparator','rounds','memoryCost']);if(h.algorithm!=='SCRYPT')fail('unsupported-hash');base64(h.key,1,128);base64(h.saltSeparator,0,64);integer(h.rounds,1,8);integer(h.memoryCost,1,14);}
function user(u){
 keys(u,['localId','email','emailVerified','passwordHash','salt'],['displayName','photoUrl','createdAt','lastSignedInAt','disabled','providerUserInfo','customAttributes','validSince','mfaInfo','phoneNumber']);id(u.localId);text(u.email,254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)||typeof u.emailVerified!=='boolean'||u.disabled!==undefined&&typeof u.disabled!=='boolean')fail('user-schema');
 if(u.mfaInfo!==undefined&&(!Array.isArray(u.mfaInfo)||u.mfaInfo.length)||u.phoneNumber!==undefined&&u.phoneNumber!=='')fail('unsupported-identity');
 base64(u.passwordHash,1,1024);base64(u.salt,1,1024);
 if(u.providerUserInfo!==undefined){if(!Array.isArray(u.providerUserInfo)||u.providerUserInfo.length>1)fail('unsupported-provider');for(const provider of u.providerUserInfo){keys(provider,['providerId','rawId','email'],['displayName','photoUrl']);if(provider.providerId!=='password'||typeof provider.rawId!=='string'||typeof provider.email!=='string'||provider.rawId.toLowerCase()!==u.email.toLowerCase()||provider.email.toLowerCase()!==u.email.toLowerCase())fail('unsupported-provider');if(provider.displayName!==undefined)text(provider.displayName,256,true);if(provider.photoUrl!==undefined)text(provider.photoUrl,2048,true);}}
 if(u.customAttributes!==undefined){text(u.customAttributes,1000,true);let claims;try{claims=JSON.parse(u.customAttributes);}catch{fail('claims');}object(claims);json(claims);}
 for(const k of ['displayName','photoUrl'])if(u[k]!==undefined)text(u[k],k==='displayName'?256:2048,true);
 if(u.photoUrl&&(!/^https:\/\//.test(u.photoUrl)||u.photoUrl.length>2048))fail('photo-url');
 for(const k of ['createdAt','lastSignedInAt','validSince'])if(u[k]!==undefined&&!(typeof u[k]==='string'&&/^\d{1,16}$/.test(u[k])&&Number.isSafeInteger(Number(u[k]))&&(k==='validSince'||Number.isFinite(new Date(Number(u[k])).getTime()))))fail('timestamp');
 if(bytes(u).length>L.recordBytes)fail('record-limit');
}
function validatePayload(p,c){
 keys(p,['format','version','context','hash','authExportBase64','operatorRecordsBase64','uidInventory','sourceAuthSha256','sourceOperatorSha256','activationAllowed']);context(p.context);if(canonical(p.context)!==canonical(c)||p.format!=='strawberry-recovery-authority' ||p.version!==1||p.activationAllowed!==false)fail('context');hashOptions(p.hash);
 if(!hex.test(p.sourceAuthSha256)||!hex.test(p.sourceOperatorSha256)||bytes(p).length>L.plainBytes)fail('byte-limit');
 const authBytes=base64(p.authExportBase64,1,L.plainBytes),operatorBytes=base64(p.operatorRecordsBase64,1,L.plainBytes);let auth,operators;
 try{if(authorityDigest(authBytes)!==p.sourceAuthSha256||authorityDigest(operatorBytes)!==p.sourceOperatorSha256)fail('source-artifact-integrity');auth=parse(authBytes,L.plainBytes);operators=parse(operatorBytes,L.plainBytes);}finally{authBytes.fill(0);operatorBytes.fill(0);}
 keys(auth,['users']);if(!Array.isArray(auth.users)||!auth.users.length||auth.users.length>L.users||!Array.isArray(operators)||operators.length>L.operatorRecords)fail('count-limit');
 // Import rows are derived from the exact retained original bytes. An asserted
 // digest cannot be detached from independently serialized replacement rows.
 const users=auth.users.sort((a,b)=>a.localId<b.localId?-1:a.localId>b.localId?1:0),operatorRecords=operators.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const uids=new Set(),emails=new Set();let last='';for(const u of users){user(u);if(u.localId<=last||uids.has(u.localId)||emails.has(u.email.toLowerCase()))fail('user-order-or-duplicate');last=u.localId;uids.add(u.localId);emails.add(u.email.toLowerCase());}
 if(canonical(p.uidInventory)!==canonical([...uids]))fail('uid-inventory');
 last='';for(const row of operatorRecords){keys(row,['path','payload']);text(row.path,250);const parts=row.path.split('/');if(parts.length!==2||!AUTHORITY_OPERATOR_COLLECTIONS.includes(parts[0]))fail('operator-path');id(parts[1]);object(row.payload);json(row.payload);if(row.payload.tenantId!==c.tenantId)fail('operator-tenant');if(row.path<=last||bytes(row).length>L.recordBytes)fail('operator-order-or-limit');last=row.path;}
 return {...p,users,operatorRecords};
}
function derive(master,c){if(!(master instanceof Uint8Array)||master.length!==32)fail('key-required');return Buffer.from(hkdfSync('sha256',master,bytes(c),Buffer.from('strawberry-recovery-authority-v1'),32));}
export function captureRecoveryAuthorityPackage({authExportJson,hash,operatorRecordsJson,context:c,requiredUids,masterKey}){
 context(c);hashOptions(hash);const auth=parse(authExportJson,L.plainBytes),operators=parse(operatorRecordsJson,L.plainBytes);keys(auth,['users']);if(!Array.isArray(auth.users)||!Array.isArray(operators))fail('schema');if(!auth.users.length||auth.users.length>L.users||operators.length>L.operatorRecords)fail('count-limit');
 if(!Array.isArray(requiredUids)||requiredUids.length>L.users||new Set(requiredUids).size!==requiredUids.length)fail('uid-inventory');for(const uid of requiredUids)id(uid);
 const p={format:'strawberry-recovery-authority',version:1,context:structuredClone(c),hash:structuredClone(hash),authExportBase64:Buffer.from(authExportJson).toString('base64'),operatorRecordsBase64:Buffer.from(operatorRecordsJson).toString('base64'),uidInventory:auth.users.map(u=>u.localId).sort(),sourceAuthSha256:authorityDigest(authExportJson),sourceOperatorSha256:authorityDigest(operatorRecordsJson),activationAllowed:false};validatePayload(p,c);
 if(canonical([...requiredUids].sort())!==canonical(p.uidInventory))fail('uid-inventory');
 const key=derive(masterKey,c),nonce=randomBytes(12),plain=bytes(p);try{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(bytes(c));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return bytes({format:'strawberry-recovery-authority-envelope',version:1,algorithm:'AES-256-GCM/HKDF-SHA256',context:c,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')});}finally{key.fill(0);plain.fill(0);}
}
export function openRecoveryAuthorityPackage({envelope,masterKey,expected}){
 context(expected);const e=parse(envelope,L.envelopeBytes,{canonicalOnly:true,stringLimit:L.envelopeBytes});keys(e,['format','version','algorithm','context','nonce','ciphertext','tag']);context(e.context);if(e.format!=='strawberry-recovery-authority-envelope'||e.version!==1||e.algorithm!=='AES-256-GCM/HKDF-SHA256'||canonical(e.context)!==canonical(expected))fail('context');
 const nonce=base64(e.nonce,12,12),ciphertext=base64(e.ciphertext,1,L.plainBytes),tag=base64(e.tag,16,16),key=derive(masterKey,e.context);let plain;
 try{const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(bytes(e.context));decipher.setAuthTag(tag);try{plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);}catch{fail('authentication');}const p=parse(plain,L.plainBytes,{canonicalOnly:true,stringLimit:L.plainBytes});return validatePayload(p,expected);}finally{key.fill(0);plain?.fill(0);}
}
// A planning check, deliberately never an activation capability.
export function validateRecoveryAuthorityActivationPlan({context:c,uidInventory,evidence}){
 context(c);if(!Array.isArray(uidInventory)||!uidInventory.length||uidInventory.length>L.users)fail('uid-inventory');for(const uid of uidInventory)id(uid);if(canonical([...new Set(uidInventory)].sort())!==canonical(uidInventory))fail('uid-inventory');
 keys(evidence,[],['providerConsistency','independentObjectRestore','keyCustody','freshEnrollment','financialReconciliation']);const missing=[];
 for(const name of ['providerConsistency','independentObjectRestore','keyCustody','freshEnrollment','financialReconciliation']){const item=evidence[name];if(!item){missing.push(name);continue;}keys(item,['contextSha256','artifactSha256','uidInventorySha256']);if(item.contextSha256!==authorityDigest(c)||item.uidInventorySha256!==authorityDigest(uidInventory)||!hex.test(item.artifactSha256))fail('plan-evidence-context');}
 return Object.freeze({format:'strawberry-recovery-authority-activation-plan-v1',contextSha256:authorityDigest(c),uidInventorySha256:authorityDigest(uidInventory),suppliedEvidenceComplete:!missing.length,missing,activationAllowed:false,productionActivationImplemented:false,blockers:[...missing,'independent-provider-acceptance-required','production-activation-not-implemented']});
}
