/** Local owner-admin API. Inject clients; importing discovers no credentials.
 * previewAction -> exact confirmation -> executeAction. No payload overrides.
 * Passwords live only in expiring memory and never enter previews/audit files.
 */
import {createHash,createPublicKey,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

export const ADMIN_PROJECT_ID='strawberry-trade-261017-6a49b';
const DAY=86400000,TRIAL=30*DAY,TTL=5*60000,QUIET=30000;
export class AdminOperationError extends Error {
  constructor(code,details={}){super(code);this.name='AdminOperationError';this.code=code;this.details=details;}
}
const fail=(code,details)=>{throw new AdminOperationError(code,details);};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const id=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(v))fail('invalid-id');return v;};
const text=(v,max=120)=>{if(typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>max||/[\x00-\x1f\x7f]/.test(v))fail('invalid-text');return v;};
const email=v=>{text(v,254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))fail('invalid-email');return v;};
const integer=(v,min=1,max=1000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('invalid-number');return v;};
const keys=(v,allowed)=>{if(!v||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).some(k=>!allowed.includes(k)))fail('unexpected-fields');};
const publicAccount=u=>({uid:u.uid,email:u.email||'',displayName:u.displayName||'',emailVerified:u.emailVerified===true,disabled:u.disabled===true});
const data=s=>s.exists?s.data():null;
const safeTime=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function clock(snaps){const times=snaps.map(s=>s?.readTime?.toMillis?.());if(times.some(t=>!Number.isFinite(t)||t<=0||!Number.isSafeInteger(Math.floor(t))))fail('trusted-server-time-required');const t=Math.floor(Math.max(...times));if(!Number.isSafeInteger(t+36600*DAY))fail('invalid-server-time');return t;}
function device(value){
  keys(value,['deviceId','publicKeySpki','algorithm']);id(value.deviceId);
  if(value.algorithm!==undefined&&!['P256-SHA256','P-256'].includes(value.algorithm))fail('invalid-device-request');
  try {const bytes=Buffer.from(value.publicKeySpki,'base64url'),key=createPublicKey({key:bytes,format:'der',type:'spki'});
    if(typeof value.publicKeySpki!=='string'||value.publicKeySpki.length>500||bytes.toString('base64url')!==value.publicKeySpki||
      key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||
      !key.export({type:'spki',format:'der'}).equals(bytes)||createHash('sha256').update(bytes).digest('base64url')!==value.deviceId)throw Error();
  }catch{fail('invalid-device-request');}
  return {deviceId:value.deviceId,publicKeySpki:value.publicKeySpki};
}
function normalize(input){
  const allowed={
    'create-account':['type','email','displayName','password','sendVerificationEmail'],
    'send-verification-email':['type','email','password'],
    'create-tenant':['type','tenantId','name','ownerUid','expectedEmail','deviceRequest','maxDevices'],
    'add-manager':['type','tenantId','uid','expectedEmail','name','deviceRequest'],
    'set-tenant-enabled':['type','tenantId','enabled'],
    'set-member-active':['type','tenantId','uid','active'],
    'activate-license':['type','tenantId','unit','count','maxDevices'],
    'delete-tenant':['type','tenantId'],
  };
  if(!allowed[input?.type])fail('unknown-action');keys(input,allowed[input.type]);
  const a=structuredClone(input);
  if(a.tenantId!==undefined)id(a.tenantId);
  if(a.type==='create-account'||a.type==='send-verification-email'){
    email(a.email);if(typeof a.password!=='string'||a.password.length<8||a.password.length>128)fail('invalid-password');
    if(a.type==='create-account'){text(a.displayName);if(a.sendVerificationEmail!==undefined&&typeof a.sendVerificationEmail!=='boolean')fail('invalid-boolean');a.sendVerificationEmail=a.sendVerificationEmail===true;}
  }else if(a.type==='create-tenant'){
    id(a.ownerUid);email(a.expectedEmail);text(a.name);integer(a.maxDevices);a.deviceRequest=device(a.deviceRequest);
  }else if(a.type==='add-manager'){
    id(a.uid);email(a.expectedEmail);text(a.name);a.deviceRequest=device(a.deviceRequest);
  }else if(a.type==='set-tenant-enabled'){if(typeof a.enabled!=='boolean')fail('invalid-boolean');}
  else if(a.type==='set-member-active'){id(a.uid);if(typeof a.active!=='boolean')fail('invalid-boolean');}
  else if(a.type==='activate-license'){
    if(!['days','months','permanent'].includes(a.unit))fail('invalid-license-term');
    if(a.unit==='permanent'){if(a.count!==undefined&&a.count!==null)fail('invalid-license-term');a.count=null;}
    else integer(a.count,1,a.unit==='days'?36600:1200);
    if(a.maxDevices!==undefined)integer(a.maxDevices);
  }
  return a;
}
function expiry(start,unit,count){
  if(unit==='permanent')return null;
  if(unit==='days')return start+count*DAY;
  const d=new Date(start),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+count);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.getTime();
}
const publicName=value=>typeof value==='string'&&value.length<=120&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():'';
const hasTenantName=t=>Boolean(publicName(t.name)||publicName(t.businessName));
function tenantView(tenantId,t){return {id:tenantId,tenantId,name:publicName(t.name)||publicName(t.businessName)||tenantId,businessName:publicName(t.businessName)||publicName(t.name)||tenantId,
  ownerUid:t.ownerUid,enabled:t.enabled===true,deleting:Boolean(t.adminDeleting),trialStartMs:t.trialStartMs??null,trialEndMs:t.trialEndMs??null,
  paidUntilMs:t.paidUntilMs??null,perpetual:t.perpetual===true,maxDevices:t.maxDevices||1,managerDeviceCount:t.managerDeviceCount||0};}

export function createAdminOperations({db,auth,receiptDirectory,now=Date.now,sendVerificationEmail}={}){
  if(db?.projectId!==ADMIN_PROJECT_ID||db?.databaseId!=='(default)'||auth?.app?.options?.projectId!==ADMIN_PROJECT_ID)fail('wrong-admin-target');
  if(receiptDirectory!==undefined&&!isAbsolute(receiptDirectory))fail('absolute-receipt-directory-required');
  const previews=new Map(),profileCache=new Map();
  async function mapBounded(values,task){
    const result=new Array(values.length);let next=0;
    await Promise.all(Array.from({length:Math.min(4,values.length)},async()=>{for(;;){const index=next++;if(index>=values.length)return;result[index]=await task(values[index]);}}));
    return result;
  }
  async function ownerEmails(uids){
    const unique=[...new Set(uids.filter(uid=>typeof uid==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(uid)))],emails=new Map(),missing=[],time=now();
    for(const uid of unique){const cached=profileCache.get(uid);if(cached&&cached.expiresAtMs>time)emails.set(uid,cached.email);else missing.push(uid);}
    const remember=(uid,value='',available=false)=>{
      // Cache only the public email required by this view, never Auth records.
      const address=typeof value==='string'&&value.length<=254&&!/[\x00-\x1f\x7f]/.test(value)?value:'';
      if(profileCache.size>=1000&&!profileCache.has(uid))profileCache.delete(profileCache.keys().next().value);
      profileCache.set(uid,{email:address,expiresAtMs:time+(available?30000:5000)});emails.set(uid,address);
    };
    if(typeof auth.getUsers==='function'){
      for(let offset=0;offset<missing.length;offset+=100){const batch=missing.slice(offset,offset+100),allowed=new Set(batch),found=new Map();
        try{const result=await auth.getUsers(batch.map(uid=>({uid})));for(const user of result.users||[])if(allowed.has(user.uid))found.set(user.uid,user.email);}catch{}
        for(const uid of batch)remember(uid,found.get(uid),found.has(uid));
      }
    }else await mapBounded(missing,async uid=>{try{const user=await auth.getUser(uid);if(user.uid===uid){remember(uid,user.email,true);return;}}catch{}remember(uid);});
    return emails;
  }
  async function legacyTenantName(tenantId,t,knownMembers){
    if(hasTenantName(t)||typeof t.ownerUid!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(t.ownerUid))return t;
    try{const member=knownMembers?knownMembers.find(s=>s.id===t.ownerUid):await rootRef(tenantId).collection('members').doc(t.ownerUid).get();
      const m=member?.data(),name=publicName(m?.businessName)||publicName(m?.name);return name?{...t,name,businessName:name}:t;
    }catch{return t;}
  }
  const rootRef=tenantId=>db.doc('tenants/'+id(tenantId));
  const historyRef=uid=>db.doc('adminEnrollmentHistory/'+hash(id(uid)));
  const tombstoneRef=tenantId=>db.doc('adminTenantHistory/'+id(tenantId));
  const controlRef=operationId=>db.doc('adminDeletions/'+id(operationId));
  const operationRef=operationId=>db.doc('adminOperations/'+id(operationId));
  function clean(){for(const [key,p]of previews)if(p.expiresAtMs<now()&&!p.running){delete p.action.password;clearTimeout(p.timer);previews.delete(key);}}
  async function owner(uid,expected){const u=await auth.getUser(uid);if(u.uid!==uid||u.email!==expected||u.emailVerified!==true||u.disabled)fail('verified-enabled-account-required');return publicAccount(u);}
  async function lookupAccount({email:address}){
    email(address);try{return {found:true,account:publicAccount(await auth.getUserByEmail(address))};}
    catch(e){if(e.code==='auth/user-not-found')return {found:false,account:null};fail('account-lookup-failed');}
  }
  async function listTenants({limit=50,cursor}={}){
    integer(limit,1,100);let q=db.collection('tenants').orderBy('__name__').limit(limit+1);if(cursor)q=q.startAfter(id(cursor));
    const [result,pending]=await Promise.all([q.get(),db.collection('adminTenantHistory').where('state','==','deleting').limit(101).get()]);
    const normal=await mapBounded(result.docs.slice(0,limit),async s=>tenantView(s.id,await legacyTenantName(s.id,s.data()))),items=new Map(normal.map(t=>[t.tenantId,t]));
    for(const s of pending.docs.slice(0,100))if(!items.has(s.id))items.set(s.id,{...tenantView(s.id,{...s.data(),enabled:false}),deleting:true,missingParent:true,
      operationId:s.data().operationId,nextCheckAfterMs:Number.isSafeInteger(s.data().firstEmptyAtMs)?s.data().firstEmptyAtMs+QUIET:null});
    const profiles=await ownerEmails([...items.values()].map(t=>t.ownerUid));
    return {items:[...items.values()].map(t=>({...t,ownerEmail:profiles.get(t.ownerUid)||''})),nextCursor:result.docs.length>limit?normal.at(-1).tenantId:null,pendingTruncated:pending.docs.length>100};
  }
  async function tenantDetail({tenantId}){
    const ref=rootRef(tenantId),snap=await ref.get();if(!snap.exists){
      const tomb=await tombstoneRef(tenantId).get(),t=data(tomb);if(t?.state!=='deleting')fail('tenant-not-found');
      const profiles=await ownerEmails([t.ownerUid]);
      return {tenant:{...tenantView(tenantId,{...t,enabled:false}),ownerEmail:profiles.get(t.ownerUid)||'',deleting:true,missingParent:true,operationId:t.operationId,
        nextCheckAfterMs:Number.isSafeInteger(t.firstEmptyAtMs)?t.firstEmptyAtMs+QUIET:null},members:[],devices:[],membersTruncated:false,devicesTruncated:false};
    }
    const [members,devices,profiles]=await Promise.all([ref.collection('members').limit(201).get(),ref.collection('devices').limit(201).get(),ownerEmails([snap.data().ownerUid])]);
    return {tenant:{...tenantView(tenantId,await legacyTenantName(tenantId,snap.data(),members.docs)),ownerEmail:profiles.get(snap.data().ownerUid)||''},members:members.docs.slice(0,200).map(s=>({id:s.id,uid:s.id,name:s.data().name||'',businessName:s.data().businessName||'',role:s.data().role,active:s.data().active===true,epoch:s.data().epoch||1})),
      devices:devices.docs.slice(0,200).map(s=>({id:s.id,deviceId:s.id,uid:s.data().uid,role:s.data().role,active:s.data().active===true})),membersTruncated:members.docs.length>200,devicesTruncated:devices.docs.length>200};
  }
  async function inspect(tx,a){
    const snaps=[],get=async ref=>{const s=await tx.get(ref);snaps.push(s);return s;};
    const root=await get(rootRef(a.tenantId)),t=data(root),tombstone=await get(tombstoneRef(a.tenantId));
    const state={tenant:t,tombstone:data(tombstone)},refs={root:root.ref||rootRef(a.tenantId)};
    if(a.type==='create-tenant'){
      const h=await get(historyRef(a.ownerUid));state.ownerHistory=data(h);
      const q=await get(db.collection('tenants').where('ownerUid','==',a.ownerUid).limit(2));state.ownerTenantIds=q.docs.map(s=>s.id);
      const [m,d]=[await get(rootRef(a.tenantId).collection('members').doc(a.ownerUid)),await get(rootRef(a.tenantId).collection('devices').doc(a.deviceRequest.deviceId))];
      state.member=data(m);state.device=data(d);
      if(t||tombstone.exists||h.exists||q.docs.length||m.exists||d.exists)fail('tenant-or-owner-history-exists');
    }else if(a.type==='delete-tenant'){
      if(tombstone.exists&&state.tombstone.state==='deleted'&&!t)fail('tenant-already-deleted');
      if(!t&&!tombstone.exists)fail('tenant-not-found');
      if(t?.adminDeleting){if(t.enabled!==false||state.tombstone?.operationId!==t.adminDeleting)fail('deletion-state-conflict');}
      else if(state.tombstone?.state==='deleting'){
        if(t)fail('tenant-recreated-during-deletion');
      }
    }else{
      if(!t)fail('tenant-not-found');if(t.adminDeleting||state.tombstone?.state==='deleting'||state.tombstone?.state==='deleted')fail('tenant-deleting');
      if(a.type==='activate-license'&&t.perpetual===true&&a.unit!=='permanent')fail('permanent-license-cannot-be-shortened');
      if(a.type==='add-manager'||a.type==='set-member-active'||a.type==='activate-license'){
        const devices=await get(rootRef(a.tenantId).collection('devices').where('role','==','manager').limit(1001));
        if(devices.docs.length>1000)fail('manager-list-limit-exceeded');
        // The Firestore document ID selects the document to update. Stored payload
        // IDs must never redirect a manager toggle to a different device.
        state.managerDevices=devices.docs.map(s=>({...s.data(),id:s.id}));
        if(a.type!=='activate-license'){
          const m=await get(rootRef(a.tenantId).collection('members').doc(a.uid));state.member=data(m);
          if(a.type==='add-manager'){
            const d=await get(rootRef(a.tenantId).collection('devices').doc(a.deviceRequest.deviceId));state.device=data(d);
            if(d.exists||m.exists)fail('membership-or-device-already-exists');
            if(state.managerDevices.filter(d=>d.active===true).length>=(t.maxDevices||1))fail('manager-device-limit');
          }else{
            if(!m.exists||state.member.role!=='manager')fail('manager-not-found');
            state.targetDevices=state.managerDevices.filter(d=>d.uid===a.uid);
            if(!state.targetDevices.length)fail('manager-device-not-found');
            // Leave room for the member, root, audit and operation receipt in Firestore's
            // 500-write transaction limit. Never partially toggle a manager.
            if(state.targetDevices.length>496)fail('manager-device-limit-exceeded');
            const activeOthers=state.managerDevices.filter(d=>d.active===true&&d.uid!==a.uid).length;
            if(a.active&&activeOthers+state.targetDevices.length>(t.maxDevices||1))fail('manager-device-limit');
          }
        }else if((a.maxDevices??t.maxDevices??1)<state.managerDevices.filter(d=>d.active===true).length)fail('manager-device-limit');
      }
    }
    return {state,serverTimeMs:clock(snaps)};
  }
  function summary(a,s){
    if(a.type==='create-account')return {email:a.email,displayName:a.displayName,sendVerificationEmail:a.sendVerificationEmail,willCreateUnverified:true};
    if(a.type==='send-verification-email')return {email:a.email,sendVerificationEmail:true};
    if(a.type==='create-tenant')return {tenantId:a.tenantId,businessName:a.name,ownerUid:a.ownerUid,email:a.expectedEmail,deviceId:a.deviceRequest.deviceId,maxDevices:a.maxDevices,trialDays:30,globalSessionRevocation:false};
    if(a.type==='add-manager')return {tenantId:a.tenantId,uid:a.uid,email:a.expectedEmail,name:a.name,deviceId:a.deviceRequest.deviceId,activeManagerDevices:s.managerDevices.filter(d=>d.active).length,maxDevices:s.tenant.maxDevices||1,globalSessionRevocation:false};
    if(a.type==='set-tenant-enabled')return {tenantId:a.tenantId,from:s.tenant.enabled===true,to:a.enabled,offlineCopiesUnaffected:true};
    if(a.type==='set-member-active')return {tenantId:a.tenantId,uid:a.uid,from:s.member.active===true,to:a.active,offlineCopiesUnaffected:true};
    if(a.type==='activate-license')return {tenantId:a.tenantId,unit:a.unit,count:a.count,maxDevices:a.maxDevices??s.tenant.maxDevices??1,previousExpiryMs:s.tenant.paidUntilMs??s.tenant.trialEndMs,perpetual:a.unit==='permanent',preservesTrial:true};
    return {tenantId:a.tenantId,permanent:true,cloudChildrenDeleted:true,authUsersKept:true,minimalHistoryKept:true,offlineCopiesRemain:true,resuming:s.tombstone?.state==='deleting',quietWindowSeconds:QUIET/1000};
  }
  async function previewAction(input){
    clean();if(previews.size>=100)fail('too-many-pending-previews');const a=normalize(input);let state,account;
    if(a.type==='create-account'||a.type==='send-verification-email'){
      const found=await lookupAccount({email:a.email});
      if(a.type==='create-account'&&found.found)fail('account-already-exists');
      if(a.type==='send-verification-email'&&(!found.found||found.account.disabled||found.account.emailVerified))fail('unverified-enabled-account-required');
      if((a.sendVerificationEmail||a.type==='send-verification-email')&&typeof sendVerificationEmail!=='function')fail('verification-email-unavailable');
      state={account:found.account};
    }else{
      if(a.type==='create-tenant')account=await owner(a.ownerUid,a.expectedEmail);
      if(a.type==='add-manager')account=await owner(a.uid,a.expectedEmail);
      ({state}=await db.runTransaction(tx=>inspect(tx,a),{readOnly:true}));
    }
    const previewId=randomUUID(),expiresAtMs=now()+TTL,publicAction={...a};delete publicAction.password;
    const confirmationText=a.type==='delete-tenant'?'DELETE '+a.tenantId:a.type==='create-account'?'CREATE '+a.email:a.type==='send-verification-email'?'SEND '+a.email:'APPLY '+a.tenantId;
    const planHash=hash({previewId,action:publicAction,state,account:account||null});
    const entry={action:a,state,account,expiresAtMs,planHash,confirmationText,running:false};
    entry.timer=setTimeout(()=>{if(!entry.running){delete entry.action.password;previews.delete(previewId);}},TTL);entry.timer.unref?.();
    previews.set(previewId,entry);
    return {previewId,type:a.type,tenantId:a.tenantId,confirmationText,expiresAtMs,summary:summary(a,state),planHash};
  }
  async function localReceipt(previewId,result){if(!receiptDirectory)return;await mkdir(receiptDirectory,{recursive:true,mode:0o700});
    await writeFile(join(receiptDirectory,previewId+'.json'),JSON.stringify({previewId,...result})+'\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')fail('local-receipt-write-failed',{actionCompleted:true});});}
  async function accountAction(p){
    const a=p.action;if(typeof a.password!=='string')fail('new-account-preview-required');
    const found=await lookupAccount({email:a.email});
    if(a.type==='create-account'){
      if(found.found)fail('account-already-exists');let created;
      try{created=await auth.createUser({email:a.email,displayName:a.displayName,password:a.password,emailVerified:false,disabled:false});}
      catch(e){if(e.code==='auth/email-already-exists')fail('account-already-exists');fail('account-create-outcome-uncertain');}
      let sent=false;if(a.sendVerificationEmail){try{await sendVerificationEmail({uid:created.uid,email:a.email,password:a.password});sent=true;}catch{return {status:'partial',accountCreated:true,account:publicAccount(created),verificationEmailSent:false,code:'verification-email-failed'};}}
      return {status:'applied',accountCreated:true,account:publicAccount(created),verificationEmailSent:sent};
    }
    if(!found.found||found.account.disabled||found.account.emailVerified)fail('unverified-enabled-account-required');
    if(hash({account:found.account})!==hash(p.state))fail('stale-preview');
    try{await sendVerificationEmail({uid:found.account.uid,email:a.email,password:a.password});}catch{fail('verification-email-failed',{accountCreated:false});}
    return {status:'applied',verificationEmailSent:true,accountCreated:false};
  }
  async function ordinary(p,previewId){
    const a=p.action;if(a.type==='create-tenant')await owner(a.ownerUid,a.expectedEmail);if(a.type==='add-manager')await owner(a.uid,a.expectedEmail);
    return db.runTransaction(async tx=>{
      const op=await tx.get(operationRef(previewId));if(op.exists){if(op.data().planHash!==p.planHash)fail('operation-receipt-conflict');return op.data().result;}
      if(a.type==='create-tenant')await owner(a.ownerUid,a.expectedEmail);if(a.type==='add-manager')await owner(a.uid,a.expectedEmail);
      const {state,serverTimeMs:time}=await inspect(tx,a);if(hash(state)!==hash(p.state))fail('stale-preview');
      const root=rootRef(a.tenantId);let result={status:'applied',type:a.type,tenantId:a.tenantId};
      if(a.type==='create-tenant'){
        const d=a.deviceRequest;tx.create(root,{ownerUid:a.ownerUid,name:a.name,businessName:a.name,enabled:true,trialStartMs:time,trialEndMs:time+TRIAL,entitlementEpoch:1,licenseId:'trial_'+a.tenantId,maxDevices:a.maxDevices,managerDeviceCount:1,deviceCount:1,sequence:0});
        tx.create(root.collection('members').doc(a.ownerUid),{uid:a.ownerUid,role:'manager',name:a.name,businessName:a.name,active:true,epoch:1});
        tx.create(root.collection('devices').doc(d.deviceId),{id:d.deviceId,deviceId:d.deviceId,tenantId:a.tenantId,uid:a.ownerUid,publicKeySpki:d.publicKeySpki,active:true,role:'manager',enrolledAtMs:time});
        const history={tenantId:a.tenantId,trialStartMs:time,trialEndMs:time+TRIAL,status:'active'};tx.create(historyRef(a.ownerUid),history);tx.create(tombstoneRef(a.tenantId),history);
        result={...result,trialStartMs:time,trialEndMs:time+TRIAL};
      }else if(a.type==='add-manager'){
        const d=a.deviceRequest,t=state.tenant;tx.create(root.collection('members').doc(a.uid),{uid:a.uid,role:'manager',name:a.name,businessName:t.businessName||t.name||a.tenantId,active:true,epoch:1});
        tx.create(root.collection('devices').doc(d.deviceId),{id:d.deviceId,deviceId:d.deviceId,tenantId:a.tenantId,uid:a.uid,publicKeySpki:d.publicKeySpki,active:true,role:'manager',enrolledAtMs:time});
        tx.update(root,{managerDeviceCount:state.managerDevices.filter(d=>d.active===true).length+1,deviceCount:integer(t.deviceCount??0,0,Number.MAX_SAFE_INTEGER-1)+1});
      }else if(a.type==='set-tenant-enabled')tx.update(root,{enabled:a.enabled});
      else if(a.type==='set-member-active'){
        tx.update(root.collection('members').doc(a.uid),{active:a.active,epoch:integer(state.member.epoch??1,1,Number.MAX_SAFE_INTEGER-1)+1});
        for(const d of state.targetDevices)tx.update(root.collection('devices').doc(d.id),{active:a.active});
        tx.update(root,{managerDeviceCount:state.managerDevices.filter(d=>d.uid!==a.uid&&d.active).length+(a.active?state.targetDevices.length:0)});
      }else if(a.type==='activate-license'){
        const t=state.tenant,epoch=integer((t.entitlementEpoch||1)+1,1,Number.MAX_SAFE_INTEGER),start=Math.max(time,t.paidUntilMs||0,t.trialEndMs||0),end=expiry(start,a.unit,a.count);
        const entitlementPayload={type:'entitlement',version:1,tenantId:a.tenantId,licenseId:'admin_'+previewId,epoch,issuedAtMs:time,notBeforeMs:time,expiresAtMs:end,trialStartMs:null,trial:false,maxDevices:a.maxDevices??t.maxDevices??1};
        tx.update(root,{entitlementPayload,entitlementEpoch:epoch,licenseId:entitlementPayload.licenseId,paidUntilMs:end,perpetual:end===null,maxDevices:entitlementPayload.maxDevices,enabled:true});
        result={...result,expiresAtMs:end,entitlementEpoch:epoch};
      }
      tx.create(root.collection('audit').doc('admin_'+previewId),{action:a.type,actorUid:'local-owner-admin',atMs:time,operationId:previewId});
      tx.create(operationRef(previewId),{type:a.type,tenantId:a.tenantId,planHash:p.planHash,result});return result;
    });
  }
  async function hasDescendants(root){
    for(const collection of await root.listCollections())if((await collection.listDocuments()).length)return true;
    return false;
  }
  async function deletion(p,previewId){
    const a=p.action,root=rootRef(a.tenantId);let operationId=p.state.tombstone?.operationId||previewId;
    await db.runTransaction(async tx=>{
      const {state,serverTimeMs:time}=await inspect(tx,a),t=state.tenant;
      if(state.tombstone?.state==='deleting'){
        if(p.state.tombstone?.state!=='deleting'||p.state.tombstone.operationId!==state.tombstone.operationId)fail('stale-preview');
        operationId=state.tombstone.operationId;return;
      }
      if(hash(state)!==hash(p.state))fail('stale-preview');
      if(!t||typeof t.ownerUid!=='string')fail('tenant-owner-missing');id(t.ownerUid);
      const oldHistory=await tx.get(historyRef(t.ownerUid)),control=await tx.get(controlRef(operationId));
      if(control.exists)fail('deletion-receipt-conflict');
      const minimal={tenantId:a.tenantId,ownerUid:t.ownerUid,trialStartMs:safeTime(t.trialStartMs),trialEndMs:safeTime(t.trialEndMs),operationId,state:'deleting',requestedAtMs:time,firstEmptyAtMs:null};
      tx.update(root,{enabled:false,adminDeleting:operationId});tx.set(tombstoneRef(a.tenantId),minimal);
      // Keep only the original trial identity and times. Arbitrary old fields
      // (names, invoice bodies or operator notes) must not survive hard delete.
      const previous=data(oldHistory)||{};
      tx.set(historyRef(t.ownerUid),{tenantId:typeof previous.tenantId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(previous.tenantId)?previous.tenantId:a.tenantId,
        trialStartMs:safeTime(previous.trialStartMs)??safeTime(t.trialStartMs),trialEndMs:safeTime(previous.trialEndMs)??safeTime(t.trialEndMs),status:'deleted',deletedAtMs:time});
      tx.create(controlRef(operationId),minimal);
    });
    await db.runTransaction(async tx=>{
      const [r,c,tomb]=await tx.getAll(root,controlRef(operationId),tombstoneRef(a.tenantId));
      if(!c.exists||c.data().state==='deleted'||tomb.data()?.operationId!==operationId)fail('deletion-state-conflict');
      if(r.exists&&(r.data().enabled!==false||r.data().adminDeleting!==operationId))fail('tenant-recreated-during-deletion');
      if(r.exists)tx.delete(root); // Parent disappears before recursive purge, stopping new gateway requests.
    });
    try{await db.recursiveDelete(root);}catch{fail('tenant-delete-incomplete',{operationId,tenantId:a.tenantId});}
    const rootAfter=await root.get();if(rootAfter.exists)fail('tenant-recreated-during-deletion');
    const remaining=await hasDescendants(root);
    return db.runTransaction(async tx=>{
      const [r,c,tomb]=await tx.getAll(root,controlRef(operationId),tombstoneRef(a.tenantId));
      if(r.exists||!c.exists||tomb.data()?.operationId!==operationId)fail('deletion-state-conflict');
      const time=clock([r,c,tomb]),first=c.data().firstEmptyAtMs;
      const complete=!remaining&&Number.isSafeInteger(first)&&time-first>=QUIET;
      const firstEmptyAtMs=remaining?null:(first??time),state=complete?'deleted':'deleting';
      tx.update(controlRef(operationId),{state,firstEmptyAtMs,lastCheckedAtMs:time});tx.update(tombstoneRef(a.tenantId),{state,firstEmptyAtMs,lastCheckedAtMs:time});
      return {status:complete?'deleted':'delete-pending',tenantId:a.tenantId,operationId,authUsersKept:true,
        ...(complete?{}:{nextCheckAfterMs:(firstEmptyAtMs??time)+QUIET})};
    });
  }
  async function executeAction(input){
    keys(input,['previewId','confirmation']);clean();const p=previews.get(input.previewId);if(!p)fail('preview-expired-or-missing');
    if(input.confirmation!==p.confirmationText)fail('confirmation-mismatch');if(p.running)fail('action-in-progress');if(p.result)return structuredClone(p.result);
    p.running=true;try{
      const result=p.action.type.endsWith('account')||p.action.type==='send-verification-email'?await accountAction(p):
        p.action.type==='delete-tenant'?await deletion(p,input.previewId):await ordinary(p,input.previewId);
      p.result=result;await localReceipt(input.previewId,result);return structuredClone(result);
    }catch(e){if(e instanceof AdminOperationError)throw e;fail('admin-action-incomplete',{previewId:input.previewId});}
    finally{p.running=false;delete p.action.password;}
  }
  return {listTenants,tenantDetail,lookupAccount,createAccount:input=>previewAction({...input,type:'create-account'}),previewAction,executeAction};
}
