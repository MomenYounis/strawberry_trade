import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';
import {id,text,hash,integer,fail,canonical,keys} from './validation.mjs';
const TRIAL_MS=30*24*60*60*1000;
export function validateDevice(publicKeySpki,deviceId){
 text(publicKeySpki,500);id(deviceId);let key,bytes;
 try{bytes=Buffer.from(publicKeySpki,'base64url');key=createPublicKey({key:bytes,format:'der',type:'spki'});}catch{fail('invalid-device-key');}
 if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||createHash('sha256').update(bytes).digest('base64url')!==deviceId)fail('invalid-device-key');return key;
}
export async function provisionTenant({db,auth,tenantId,uid,name,deviceId,publicKeySpki,maxDevices=1,now=Date.now()}){
 id(tenantId);id(uid);text(name,120);integer(maxDevices,1,1000);validateDevice(publicKeySpki,deviceId);const user=await auth.getUser(uid);if(!user.emailVerified||user.disabled)fail('verified-account-required');
 // This trusted administrative function never creates Auth accounts, reuses an
 // unverified email, resets a password, or grants platform-wide privileges.
 const root=db.doc(`tenants/${tenantId}`);
 await auth.revokeRefreshTokens(uid);
 await db.runTransaction(async tx=>{
  const existing=await tx.get(root);if(existing.exists)fail('tenant-already-exists');
  tx.create(root,{ownerUid:uid,enabled:true,trialStartMs:now,trialEndMs:now+TRIAL_MS,entitlementEpoch:1,licenseId:`trial_${tenantId}`,maxDevices,managerDeviceCount:1,deviceCount:1,sequence:0});
  tx.create(root.collection('members').doc(uid),{uid,role:'manager',name,active:true,epoch:1});
  tx.create(root.collection('devices').doc(deviceId),{id:deviceId,deviceId,tenantId,uid,publicKeySpki,active:true,role:'manager',enrolledAtMs:now});
  tx.create(root.collection('audit').doc('tenant_created'),{action:'tenant-created',actorUid:'trusted-operator',ownerUid:uid,atMs:now});
 });return {tenantId,trialStartMs:now,trialEndMs:now+TRIAL_MS};
}
// Versioned invitations contain only a canonical tenant selector and 256 bits of
// randomness. The selector is not authority: every claim reads the hashed code
// and the current employee/account lock in the same Firestore transaction.
export function invitationTenant(token){
 text(token,240);
 if(!token.startsWith('v2.')){text(token,100);return null;}
 const parts=token.split('.');if(parts.length!==3||!/^[A-Za-z0-9_-]{2,160}$/.test(parts[1])||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))fail('invalid-argument');
 const tenantBytes=Buffer.from(parts[1],'base64url'),tenantId=tenantBytes.toString('utf8');
 if(tenantBytes.toString('base64url')!==parts[1]||Buffer.from(tenantId,'utf8').toString('base64url')!==parts[1]||Buffer.from(parts[2],'base64url').toString('base64url')!==parts[2])fail('invalid-argument');
 id(tenantId);return tenantId;
}
function storedBusinessName(t){return [t?.businessName,t?.name].find(value=>typeof value==='string'&&value.trim()&&value.length<=160)||'';}
export async function tenantBusinessName(tx,root,t){
 const named=storedBusinessName(t);if(named)return named;
 if(typeof t.ownerUid==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(t.ownerUid)){const owner=(await tx.get(root.collection('members').doc(t.ownerUid))).data();return storedBusinessName(owner)||'دفتر الفراولة';}
 return 'دفتر الفراولة';
}
async function invitationActor(tx,root,actor,tenantId){
 if(!actor)return;
 id(actor.uid);id(actor.deviceId);
 const [manager,device]=await Promise.all([tx.get(root.collection('members').doc(actor.uid)),tx.get(root.collection('devices').doc(actor.deviceId))]);
 const m=manager.data(),d=device.data();if(!m?.active||m.role!=='manager'||!d?.active||d.uid!==actor.uid||d.tenantId!==tenantId)fail('permission-denied');
}
export async function issueEmployeeInvitation({db,auth,tenantId,uid,employeeId,actor,now=Date.now()}){
 id(tenantId);id(employeeId);const legacy=uid!==undefined;
 if(legacy){id(uid);const user=await auth.getUser(uid);if(!user.emailVerified||user.disabled)fail('verified-account-required');await auth.revokeRefreshTokens(uid);}
 else if(!actor)fail('permission-denied');
 const root=db.doc(`tenants/${tenantId}`),accountRef=root.collection('employeeAccounts').doc(employeeId);
 const random=randomBytes(32).toString('base64url'),token=legacy?random:`v2.${Buffer.from(tenantId,'utf8').toString('base64url')}.${random}`,invitationHash=hash(token);
 // Auth revocation for old, UID-bound invitations cannot be atomic with
 // Firestore. New employee invitations never require or revoke a target UID.
 await db.runTransaction(async tx=>{
  const [ts,es,as,existing]=await Promise.all([tx.get(root),tx.get(root.collection('employees').doc(employeeId)),tx.get(accountRef),tx.get(root.collection('members').where('employeeId','==',employeeId).limit(2))]);
  const tenant=ts.data(),account=as.data();
  if(!tenant||tenant.adminDeleting||tenant.enabled!==true)fail('permission-denied');
  if(!es.data()?.active)fail('missing-employee');
  if(account?.uid||existing.docs.length)fail('employee-account-already-linked');
  if(legacy&&(await tx.get(root.collection('members').doc(uid))).exists)fail('membership-already-exists');
  await invitationActor(tx,root,actor,tenantId);
  tx.create(root.collection('invitations').doc(invitationHash),{...(legacy?{uid}:{}),employeeId,role:'employee',version:legacy?1:2,expiresAtMs:now+7*86400000,...(legacy?{minAuthTime:Math.floor(now/1000)}:{}),used:false,...(actor?{actorUid:actor.uid,actorDeviceId:actor.deviceId}:{})});
  // Reissuing replaces the pointer, invalidating every earlier pending code.
  // The durable UID claim is never cleared by an account/employee toggle.
  tx.set(accountRef,{employeeId,pendingInvitationHash:invitationHash,invitedAtMs:now});
 });return token;
}
export async function acceptInvitation({db,auth,request,now=Date.now()}){
 const d=request.data;keys(d,['tenantId','deviceId','invitationToken','signature','publicKeySpki']);id(d.tenantId);id(d.deviceId);const selectedTenant=invitationTenant(d.invitationToken);if(selectedTenant&&selectedTenant!==d.tenantId)fail('permission-denied');text(d.signature,200);const key=validateDevice(d.publicKeySpki,d.deviceId);if(!request.auth?.uid)fail('unauthenticated');const user=await auth.getUser(request.auth.uid);if(!user.emailVerified||user.disabled)fail('permission-denied');
 const revokedAfter=Math.floor(Date.parse(user.tokensValidAfterTime||'1970-01-01')/1000);if((request.auth.token?.auth_time??0)<revokedAfter)fail('reauthentication-required');
 const challenge=canonical({domain:'strawberry-accept-invitation-v1',tenantId:d.tenantId,uid:user.uid,deviceId:d.deviceId,invitationToken:d.invitationToken});
 if(!verify('sha256',Buffer.from(challenge),key,Buffer.from(d.signature,'base64url')))fail('invalid-device-proof');
 const root=db.doc(`tenants/${d.tenantId}`),invitationHash=hash(d.invitationToken),ref=root.collection('invitations').doc(invitationHash);
 return db.runTransaction(async tx=>{
  const [is,ts,ds,ms]=await Promise.all([tx.get(ref),tx.get(root),tx.get(root.collection('devices').doc(d.deviceId)),tx.get(root.collection('members').doc(user.uid))]);
  const inv=is.data(),t=ts.data(),device=ds.data(),member=ms.data();
  if(!inv||inv.role!=='employee'||(inv.uid!==undefined&&inv.uid!==user.uid)||!t?.enabled||t.adminDeleting||(selectedTenant?inv.version!==2:inv.version===2))fail('permission-denied');
  id(inv.employeeId);const accountRef=root.collection('employeeAccounts').doc(inv.employeeId);
  const [employeeSnap,accountSnap,existing]=await Promise.all([tx.get(root.collection('employees').doc(inv.employeeId)),tx.get(accountRef),tx.get(root.collection('members').where('employeeId','==',inv.employeeId).limit(2))]);
  const employee=employeeSnap.data(),account=accountSnap.data();if(!employee?.active)fail('permission-denied');
  if(inv.actorUid||inv.actorDeviceId){if(!inv.actorUid||!inv.actorDeviceId)fail('permission-denied');await invitationActor(tx,root,{uid:inv.actorUid,deviceId:inv.actorDeviceId},d.tenantId);}
  const businessName=await tenantBusinessName(tx,root,t);
  if(inv.used){
   // A lost response may safely be retried by the exact original claimant.
   // Never recreate membership, reset its epoch, reactivate it, or add a device.
   if(inv.acceptedUid!==user.uid||inv.acceptedDeviceId!==d.deviceId||account?.uid!==user.uid||account.deviceId!==d.deviceId||account.invitationHash!==invitationHash||!member?.active||member.role!=='employee'||member.employeeId!==inv.employeeId||!device?.active||device.uid!==user.uid||device.tenantId!==d.tenantId||device.publicKeySpki!==d.publicKeySpki||existing.docs.length!==1||existing.docs[0].id!==user.uid)fail('permission-denied');
   return {status:'accepted',tenantId:d.tenantId,businessName};
  }
  if(inv.expiresAtMs<=now||(request.auth.token?.auth_time??0)<(inv.minAuthTime||0)||ds.exists||ms.exists||account?.uid||existing.docs.length||(account?.pendingInvitationHash&&account.pendingInvitationHash!==invitationHash)||(selectedTenant&&account?.pendingInvitationHash!==invitationHash)||(t.deviceCount||0)>=(t.maxEmployeeDevices||5000)+t.maxDevices)fail('permission-denied');
  // Employees inherit the original tenant trial. Only this transaction claims
  // the invitation and employee, so concurrent accounts cannot both enroll.
  tx.update(ref,{used:true,acceptedAtMs:now,acceptedUid:user.uid,acceptedDeviceId:d.deviceId});
  tx.set(accountRef,{employeeId:inv.employeeId,uid:user.uid,deviceId:d.deviceId,invitationHash,acceptedAtMs:now});
  tx.create(root.collection('members').doc(user.uid),{uid:user.uid,role:'employee',employeeId:inv.employeeId,name:employee.name,businessName,active:true,epoch:1});
  tx.create(root.collection('devices').doc(d.deviceId),{id:d.deviceId,deviceId:d.deviceId,tenantId:d.tenantId,uid:user.uid,publicKeySpki:d.publicKeySpki,active:true,role:'employee',enrolledAtMs:now});
  tx.update(root,{deviceCount:(t.deviceCount||0)+1});tx.set(root.collection('audit').doc('invitation_'+invitationHash),{action:'employee-enrolled',actorUid:user.uid,employeeId:inv.employeeId,atMs:now});
  return {status:'accepted',tenantId:d.tenantId,businessName};
 });
}
