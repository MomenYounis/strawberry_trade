import {issueEmployeeInvitation,tenantBusinessName} from './enrollment.mjs';
import {signPackage,verifyPackage} from './issuer.mjs';
import {randomBytes,createPublicKey,createPrivateKey,verify as cryptoVerify} from 'node:crypto';
import {id,keys,text,integer,object,hash,canonical,entry,directory,amount,invoiceKinds,returnKinds,fail,GatewayError,signed,verifySigned,isoDate} from './validation.mjs';
export const TRIAL_MS=30*24*60*60*1000;
const collections={entry:'entries',party:'parties',employee:'employees',salary_term:'salaryTerms',submission:'submissions',review:'reviews'};
const random=()=>randomBytes(32).toString('base64url');
export function entitled(t,now){if(!t||t.adminDeleting||t.enabled!==true)return false;if(t.entitlementPayload)return t.entitlementPayload.expiresAtMs===null||now<t.entitlementPayload.expiresAtMs;return Number.isSafeInteger(t.trialEndMs)&&now<t.trialEndMs;}
export function createGateway({db,auth,now=Date.now,privateKey=()=>process.env.LICENSE_PRIVATE_KEY_PEM,publicKey=()=>process.env.LICENSE_PUBLIC_KEY_PEM,kid=()=>process.env.LICENSE_KEY_ID||'local-test-v1'}){
 const tenantRef=t=>db.doc(`tenants/${id(t)}`);
 async function identity(request){
  if(!request.auth?.uid)fail('unauthenticated');const u=await auth.getUser(request.auth.uid);
  if(u.disabled||!u.emailVerified)fail('permission-denied');
  const revokedAfter=Math.floor(Date.parse(u.tokensValidAfterTime||'1970-01-01')/1000);
  if((request.auth.token?.auth_time??0)<revokedAfter)fail('reauthentication-required');return u;
 }
 async function authority(request,{license=true,session=true,manager=false,allowDisabled=false}={}){
  const u=await identity(request),d=object(request.data);id(d.tenantId);id(d.deviceId);const root=tenantRef(d.tenantId);
  const [ts,ms,ds]=await Promise.all([root.get(),root.collection('members').doc(u.uid).get(),root.collection('devices').doc(d.deviceId).get()]);
  const t=ts.data(),m=ms.data(),device=ds.data();
  if(!t||t.adminDeleting||!m||(!allowDisabled&&!m.active)||!['manager','employee'].includes(m.role)||!device||(!allowDisabled&&!device.active)||device.uid!==u.uid||device.tenantId!==d.tenantId)fail('permission-denied');
  if(manager&&m.role!=='manager')fail('permission-denied');
  if(m.role==='employee'){
   const e=await root.collection('employees').doc(m.employeeId).get();if(!e.exists)fail('permission-denied');if(!allowDisabled&&e.data().active!==true)fail('permission-denied');m.employeeEnabled=e.data().active===true;
  }
  if(session){text(d.sessionToken,100);const ss=await root.collection('sessions').doc(hash(d.sessionToken)).get();const s=ss.data();if(!s||s.uid!==u.uid||s.deviceId!==d.deviceId||s.expiresAtMs<=now())fail('device-session-expired');}
  if(license&&!entitled(t,now()))fail('license-expired');return {u,t,m,device,root};
 }
 async function transactionAuthority(tx,c,d,{license=true,manager=false,allowDisabled=false}={}){
  const [ts,ms,ds]=await Promise.all([tx.get(c.root),tx.get(c.root.collection('members').doc(c.u.uid)),tx.get(c.root.collection('devices').doc(d.deviceId))]);
  const t=ts.data(),m=ms.data(),device=ds.data();
  if(!t||t.adminDeleting||!m||!['manager','employee'].includes(m.role)||m.role!==c.m.role||m.employeeId!==c.m.employeeId||(!allowDisabled&&!m.active)||!device||(!allowDisabled&&!device.active)||device.uid!==c.u.uid||device.tenantId!==c.root.id)fail('permission-denied');
  if(manager&&m.role!=='manager')fail('permission-denied');
  if(m.role==='employee'){const employee=(await tx.get(c.root.collection('employees').doc(m.employeeId))).data();if(!employee||(!allowDisabled&&employee.active!==true))fail('permission-denied');m.employeeEnabled=employee.active===true;}else m.employeeEnabled=true;
  if(license&&!entitled(t,now()))fail('license-expired');
  return {t,m,device};
 }
 function packageFor(c,time){
  const key=privateKey();if(!key)fail('issuer-not-configured');
  const e=c.t.entitlementPayload||{type:'entitlement',version:1,tenantId:c.root.id,licenseId:c.t.licenseId||`trial_${c.root.id}`,epoch:c.t.entitlementEpoch||1,issuedAtMs:c.t.trialStartMs,notBeforeMs:c.t.trialStartMs,expiresAtMs:c.t.perpetual?null:(c.t.paidUntilMs||c.t.trialEndMs),trial:!c.t.paidUntilMs&&!c.t.perpetual,trialStartMs:(!c.t.paidUntilMs&&!c.t.perpetual)?c.t.trialStartMs:null,maxDevices:c.t.maxDevices||1};
  const m={type:'membership',version:1,tenantId:c.root.id,uid:c.u.uid,deviceId:c.device.id||c.device.deviceId,role:c.m.role,epoch:c.m.epoch||1,entitlementEpoch:e.epoch,issuedAtMs:time,expiresAtMs:null,enabled:c.m.active===true&&c.device.active===true&&c.m.employeeEnabled!==false&&c.t.enabled===true};
  return signPackage(e,m,createPrivateKey(key),kid());
 }
 async function bootstrap(request){
  keys(request.data,['tenantId','deviceId','challengeId','signature']);const c=await authority(request,{license:false,session:false,allowDisabled:true}),time=now();
  if(!request.data.challengeId){
   const challengeId=random(),challenge=canonical({domain:'strawberry-device-enrollment-v1',nonce:random(),uid:c.u.uid,tenantId:c.root.id,deviceId:request.data.deviceId,expiresAtMs:time+300000});
   // Reading the parent in the same transaction prevents a late challenge from
   // recreating a subcollection after an operator deletes the tenant. Disabled
   // members/devices may still prove possession to receive a disabled package.
   await db.runTransaction(async tx=>{
    await transactionAuthority(tx,c,request.data,{license:false,allowDisabled:true});
    tx.create(c.root.collection('challenges').doc(challengeId),{challenge,uid:c.u.uid,deviceId:request.data.deviceId,expiresAtMs:time+300000,used:false});
   });
   return {requiresDeviceProof:true,challengeId,challenge,serverTimeMs:time};
  }
  text(request.data.challengeId,100);text(request.data.signature,200);const ref=c.root.collection('challenges').doc(request.data.challengeId);const token=random();
  await db.runTransaction(async tx=>{
   const challengeSnap=await tx.get(ref),latest=await transactionAuthority(tx,c,request.data,{license:false,allowDisabled:true});Object.assign(c,latest);const latestMember=c.m,s=challengeSnap.data();c.businessName=await tenantBusinessName(tx,c.root,c.t);if(!s||s.used||s.uid!==c.u.uid||s.deviceId!==request.data.deviceId||s.expiresAtMs<=time)fail('invalid-device-proof');
   let good=false;try{good=cryptoVerify('sha256',Buffer.from(s.challenge),createPublicKey({key:Buffer.from(c.device.publicKeySpki,'base64url'),format:'der',type:'spki'}),Buffer.from(request.data.signature,'base64url'));}catch{}
   if(!good)fail('invalid-device-proof');c.m={...latestMember,employeeEnabled:c.m.employeeEnabled,epoch:(latestMember.epoch||1)+1};tx.update(c.root.collection('members').doc(c.u.uid),{epoch:c.m.epoch});tx.update(ref,{used:true});tx.set(c.root.collection('sessions').doc(hash(token)),{uid:c.u.uid,deviceId:request.data.deviceId,expiresAtMs:time+3600000});
  });
  return {member:{uid:c.u.uid,role:c.m.role,name:c.m.name,businessName:c.businessName,employeeId:c.m.employeeId||'',epoch:c.m.epoch||1},entitlement:{trialStartMs:c.t.trialStartMs,trialEndMs:c.t.trialEndMs,paidUntilMs:c.t.paidUntilMs||null,perpetual:!!c.t.perpetual,enabled:c.t.enabled},licensePackage:packageFor(c,time),sessionToken:token,sessionExpiresAtMs:time+3600000,serverTimeMs:time};
 }
 function submission(v,c){
  keys(v,['id','tenantId','creatorUid','employeeId','kind','date','partyId','partyName','qtyMilli','grade','unit','originalId','amountMinor','note','category']);id(v.id);isoDate(v.date);text(v.note??'',1000,true);
  if(v.tenantId!==c.root.id||v.creatorUid!==c.u.uid||v.employeeId!==c.m.employeeId)fail('permission-denied');
  if(!['delivery','purchase_delivery','sale_return','purchase_return','expense_business'].includes(v.kind))fail('invalid-argument');
  text(v.partyName??'',160,true);text(v.grade??'',80,true);text(v.unit??'',40,true);
  text(v.category??'',80,true);if(v.kind==='expense_business'){v={...v,category:v.category||'مصاريف أخرى'};integer(v.amountMinor,1);if((v.qtyMilli??0)!==0)fail('invalid-argument');}
  else{id(v.partyId);integer(v.qtyMilli,1);text(v.unit,40);text(v.grade,80);if(v.kind==='purchase_delivery')integer(v.amountMinor??0,0,1_000_000_000);else if((v.amountMinor??0)!==0)fail('invalid-argument');}
  if(returnKinds.includes(v.kind)){if(v.originalId)id(v.originalId);}else if(v.originalId)fail('invalid-argument');if(v.kind!=='expense_business'&&v.category)fail('invalid-category');if(v.kind==='expense_business'&&(v.partyId||v.partyName||v.grade||v.unit))fail('invalid-argument');return {...v,status:'pending',recordedByUid:c.u.uid,recordedAtMs:now()};
 }
 async function syncOperation(request){
  keys(request.data,['tenantId','deviceId','sessionToken','operation']);const c=await authority(request);const op=object(request.data.operation);
  keys(op,['id','entity','payload','expectedRevision']);id(op.id);if(!collections[op.entity])fail('invalid-argument');integer(op.expectedRevision??0,0,100000);object(op.payload);
  if(c.m.role==='employee'&&op.entity!=='submission')fail('permission-denied');
  if(c.m.role==='manager'&&op.entity==='submission')fail('permission-denied');
  if(op.payload.tenantId!==undefined&&op.payload.tenantId!==c.root.id)fail('permission-denied');
  const digest=hash(op),time=now(),opRef=c.root.collection('operations').doc(op.id),recordId=id(op.payload.id||op.id);
  if(Buffer.byteLength(canonical(op))>20000)fail('invalid-argument');
  return db.runTransaction(async tx=>{
   // All validation reads precede every transaction write.
   const oldOp=await tx.get(opRef),latest=await transactionAuthority(tx,c,request.data),nt=latest.t;
   const windowStart=Math.floor(time/60000)*60000,rate=nt.rateWindowMs===windowStart?(nt.rateCount||0):0;
   if(oldOp.exists){if(oldOp.data().digest!==digest){if(rate>=600)fail('resource-exhausted');const conflict={id:op.id,status:'conflict',reason:'operation-id-reused',serverTimeMs:time};tx.set(c.root.collection('conflicts').doc(hash(op.id+digest)),{...conflict,local:op,actorUid:c.u.uid});tx.set(c.root,{rateWindowMs:windowStart,rateCount:rate+1},{merge:true});return conflict;}return oldOp.data().result;}
   if(rate>=600)fail('resource-exhausted');
   const recordRef=c.root.collection(collections[op.entity]).doc(recordId);let current=await tx.get(recordRef),payload,extra=[],reason=null,submissionSource=null;
   if(current.exists||op.expectedRevision!==0)reason='immutable-record-conflict';
   try{
    if(op.entity==='entry')payload=entry(op.payload,{allowReturnResidual:returnKinds.includes(op.payload.kind)});
    else if(['party','employee','salary_term'].includes(op.entity))payload=directory(op.entity,op.payload,c.root.id);
    else if(op.entity==='submission')payload=submission(op.payload,c);
    else if(op.entity==='review'){
     keys(op.payload,['id','submissionId','decision','entry','note']);id(op.payload.submissionId);text(op.payload.note??'',1000,true);if(!['approved','rejected'].includes(op.payload.decision))fail('invalid-argument');
     const sr=c.root.collection('submissions').doc(op.payload.submissionId),ss=await tx.get(sr);submissionSource=ss.data();
     if(!submissionSource||submissionSource.status!=='pending')reason='already-reviewed';
     const reviewBySubmission=await tx.get(c.root.collection('reviewLocks').doc(op.payload.submissionId));if(reviewBySubmission.exists)reason='already-reviewed';
     payload={id:recordId,tenantId:c.root.id,submissionId:op.payload.submissionId,decision:op.payload.decision,note:op.payload.note||'',reviewerUid:c.u.uid,reviewedAtMs:time};
     if(op.payload.decision==='approved'){
      const e=entry(op.payload.entry,{allowReturnResidual:returnKinds.includes(op.payload.entry.kind)});
      if(submissionSource){const s=submissionSource,expected=s.kind==='delivery'?'sale':s.kind==='purchase_delivery'?'purchase':s.kind;
       if(e.kind!==expected||e.date!==s.date||e.partyId!==(s.partyId||'')||e.qtyMilli!==(s.qtyMilli||0)||e.grade!==(s.grade||'')||e.unit!==(s.unit||'')||e.originalId!==(s.originalId||''))reason='submission-facts-changed';
       if(s.kind==='expense_business'&&(e.totalMinor!==s.amountMinor||e.category!==s.category))reason='submission-facts-changed';
       e.creatorUid=s.creatorUid;e.employeeId='';e.submittedByEmployeeId=s.employeeId;
      }
      const er=c.root.collection('entries').doc(e.id),es=await tx.get(er);if(es.exists)reason='immutable-record-conflict';extra.push({ref:er,payload:e,entity:'entry',id:e.id});payload.entryId=e.id;
     }
     if(submissionSource){const updatedSub={...submissionSource,status:op.payload.decision,...(op.payload.decision==='approved'&&submissionSource.kind==='purchase_delivery'&&op.payload.entry?.priceMinor?{approvedUnitMinor:op.payload.entry.priceMinor}:{}),...(op.payload.note?{reviewNote:op.payload.note}:{})};extra.push({ref:sr,payload:updatedSub,entity:'submission',id:op.payload.submissionId,employeeUid:submissionSource.creatorUid});}
     extra.push({ref:c.root.collection('reviewLocks').doc(op.payload.submissionId),payload:{operationId:op.id},noChange:true});
    }
    if(op.entity==='salary_term'){
     const emp=await tx.get(c.root.collection('employees').doc(payload.employeeId));if(!emp.exists)fail('missing-employee');
     const lock=c.root.collection('salaryLocks').doc(payload.employeeId+'_'+payload.effectiveMonth);if((await tx.get(lock)).exists)reason='salary-term-exists';extra.push({ref:lock,payload:{id:payload.id},noChange:true});
    }
    if(op.entity==='submission'&&payload.partyId){const party=await tx.get(c.root.collection('parties').doc(payload.partyId));if(!party.exists)fail('missing-party');const expected=['purchase_delivery','purchase_return'].includes(payload.kind)?'supplier':'merchant';if(party.data().kind!==expected)fail('wrong-party-kind');payload.partyName=party.data().name;if(returnKinds.includes(payload.kind)&&payload.originalId){const original=(await tx.get(c.root.collection('entries').doc(payload.originalId))).data();if(!original||original.kind!==(payload.kind==='sale_return'?'sale':'purchase')||original.partyId!==payload.partyId||original.grade!==payload.grade||original.unit!==payload.unit||payload.date<original.date||(await tx.get(c.root.collection('reversalLocks').doc(payload.originalId))).exists)fail('return-original-mismatch');}}
    const entries=op.entity==='entry'?[{ref:recordRef,payload,entity:'entry',id:recordId}]:extra.filter(x=>x.entity==='entry');
    for(const e of entries){
     const v=e.payload;if(v.tenantId!==undefined&&v.tenantId!==c.root.id)fail('permission-denied');v.tenantId=c.root.id;v.creatorUid=v.creatorUid&&submissionSource?v.creatorUid:c.u.uid;v.revision=1;
     if(v.partyId){const ps=await tx.get(c.root.collection('parties').doc(v.partyId));if(!ps.exists)fail('missing-party');const p=ps.data();v.partyName=p.name;const expected=['purchase','purchase_return','supplier_payment'].includes(v.kind)?'supplier':'merchant';if(!['balance_adjustment'].includes(v.kind)&&p.kind!==expected)fail('wrong-party-kind');}
     if(v.shippingEmployeeId||v.shipmentRef||v.shipmentStatus){if(!invoiceKinds.includes(v.kind)&&v.kind!=='shipment_update')fail('invalid-shipment');if(v.shippingEmployeeId){const employee=(await tx.get(c.root.collection('employees').doc(v.shippingEmployeeId))).data();if(!employee||(v.kind==='shipment_update'&&employee.active!==true))fail('missing-employee');}}
     if(v.kind==='shipment_update'){const original=(await tx.get(c.root.collection('entries').doc(v.originalId))).data(),reversal=await tx.get(c.root.collection('reversalLocks').doc(v.originalId));if(!original||!invoiceKinds.includes(original.kind)||reversal.exists||v.date<original.date)fail('shipment-original-mismatch');const orderRef=c.root.collection('shipmentCounters').doc(v.originalId),counter=(await tx.get(orderRef)).data();if(v.shipmentOrder!==(counter?.order||0)+1)fail('shipment-order-conflict');extra.push({ref:orderRef,payload:{order:v.shipmentOrder,entryId:v.id},noChange:true});}
     if(v.kind==='payroll'){const es=await tx.get(c.root.collection('employees').doc(v.employeeId));if(!es.exists)fail('missing-employee');const terms=await tx.get(c.root.collection('salaryTerms').where('employeeId','==',v.employeeId));if(!terms.docs.some(x=>x.data().effectiveMonth<=v.salaryMonth))fail('missing-salary-history');}
     if(returnKinds.includes(v.kind)&&v.originalId){
      const src=await tx.get(c.root.collection('entries').doc(v.originalId)),counterRef=c.root.collection('returnCounters').doc(v.originalId),counter=(await tx.get(counterRef)).data()||{qtyMilli:0,totalMinor:0};
      const orig=src.data(),rev=await tx.get(c.root.collection('reversalLocks').doc(v.originalId));
      if(!orig||rev.exists||orig.kind!==(v.kind==='sale_return'?'sale':'purchase')||orig.partyId!==v.partyId||orig.grade!==v.grade||orig.unit!==v.unit||orig.priceMinor!==v.priceMinor||v.date<orig.date)fail('return-original-mismatch');
      const q=counter.qtyMilli+v.qtyMilli;if(q>orig.qtyMilli)fail('return-exceeded');const required=q===orig.qtyMilli?orig.totalMinor-counter.totalMinor:amount(q,orig.priceMinor)-counter.totalMinor;
      if(required<=0||v.totalMinor!==required||counter.totalMinor+v.totalMinor>orig.totalMinor)fail('return-value-mismatch');
      extra.push({ref:counterRef,payload:{qtyMilli:q,totalMinor:counter.totalMinor+v.totalMinor},noChange:true});
     }
     if(v.kind==='reversal'){
      const src=(await tx.get(c.root.collection('entries').doc(v.originalId))).data(),lock=c.root.collection('reversalLocks').doc(v.originalId),ls=await tx.get(lock),counter=(await tx.get(c.root.collection('returnCounters').doc(v.originalId))).data();
      if(!src||ls.exists||['reversal','shipment_update'].includes(src.kind)||(counter?.qtyMilli||0)>0||v.date<src.date)fail('reversal-not-allowed');
      if(returnKinds.includes(src.kind)&&src.originalId){const cr=c.root.collection('returnCounters').doc(src.originalId),cs=(await tx.get(cr)).data();if(!cs||cs.qtyMilli<src.qtyMilli||cs.totalMinor<src.totalMinor)fail('invalid-return-counter');extra.push({ref:cr,payload:{qtyMilli:cs.qtyMilli-src.qtyMilli,totalMinor:cs.totalMinor-src.totalMinor},noChange:true});}
      extra.push({ref:lock,payload:{entryId:v.id},noChange:true});
     }
    }
   }catch(e){if(e instanceof GatewayError)reason=e.code;else throw e;}
   if(reason){const result={id:op.id,status:'conflict',reason,serverTimeMs:time};tx.set(c.root.collection('conflicts').doc(op.id),{...result,actorUid:c.u.uid,local:op,remote:current.exists?current.data():null});tx.set(opRef,{digest,result,actorUid:c.u.uid});tx.set(c.root,{rateWindowMs:windowStart,rateCount:rate+1},{merge:true});tx.set(c.root.collection('audit').doc(op.id),{action:'conflict',actorUid:c.u.uid,operationId:op.id,atMs:time,reason});return result;}
   let sequence=nt.sequence||0;
   const publish=(entity,rid,data,employeeUid)=>{
    const change={entity,id:rid,payload:data,sequence:++sequence};tx.set(c.root.collection('changes').doc(String(sequence).padStart(16,'0')),change);
    if(entity==='party'){const safe={id:data.id,tenantId:c.root.id,name:data.name,kind:data.kind,phone:data.phone||'',favorite:!!data.favorite,revision:data.revision};tx.set(c.root.collection('employeeChanges').doc(String(sequence).padStart(16,'0')),{...change,payload:safe,uid:'all'});}
    if(entity==='submission'){const uid=employeeUid||data.creatorUid;tx.set(c.root.collection('employeeChanges').doc(String(sequence).padStart(16,'0')),{...change,uid});}
   };
   tx.set(recordRef,payload);publish(op.entity,recordId,payload);
   for(const x of extra){tx.set(x.ref,x.payload);if(!x.noChange)publish(x.entity,x.id,x.payload,x.employeeUid);}
   const result={id:op.id,status:op.entity==='submission'?'awaiting_approval':'accepted',sequence,serverTimeMs:time,...(op.entity==='review'&&payload.decision==='approved'?{entry:extra.find(x=>x.entity==='entry').payload}:{})};
   tx.set(c.root,{sequence,rateWindowMs:windowStart,rateCount:rate+1},{merge:true});tx.set(opRef,{digest,result,actorUid:c.u.uid});tx.set(c.root.collection('audit').doc(op.id),{action:op.entity==='review'?payload.decision:'create',entity:op.entity,recordId,actorUid:c.u.uid,creatorUid:payload.creatorUid||c.u.uid,atMs:time,operationId:op.id});return result;
  });
 }
 async function pullChanges(request){
  keys(request.data,['tenantId','deviceId','sessionToken','afterSequence','limit']);const c=await authority(request,{license:false});const after=integer(request.data.afterSequence??0),limit=integer(request.data.limit??200,1,500);
  // Employee feed contains only sanitized directories and their own submissions.
  // Fetch each allowed uid separately; never download manager payload then filter.
  let docs;
  if(c.m.role==='manager')docs=(await c.root.collection('changes').where('sequence','>',after).orderBy('sequence').limit(limit+1).get()).docs;
  else{
   const [a,b]=await Promise.all(['all',c.u.uid].map(uid=>c.root.collection('employeeChanges').where('uid','==',uid).where('sequence','>',after).orderBy('sequence').limit(limit+1).get()));docs=[...a.docs,...b.docs].sort((x,y)=>x.data().sequence-y.data().sequence).slice(0,limit+1);
  }
  const hasMore=docs.length>limit,changes=docs.slice(0,limit).map(x=>{const {uid,...v}=x.data();return v;});
  return {changes,lastSequence:changes.length?changes.at(-1).sequence:after,hasMore,serverTimeMs:now()};
 }
 async function activateLicense(request){
  keys(request.data,['tenantId','deviceId','sessionToken','licensePackage']);const c=await authority(request,{license:false,manager:true}),pkg=object(request.data.licensePackage);keys(pkg,['version','entitlement','membership']);if(pkg.version!==1)fail('invalid-license');
  let e,m;try{({entitlement:e,membership:m}=verifyPackage(pkg,createPublicKey(publicKey()),kid()));}catch{fail('invalid-license');}const time=now();
  if(e.type!=='entitlement'||m.type!=='membership'||e.tenantId!==c.root.id||m.tenantId!==c.root.id||m.deviceId!==request.data.deviceId||m.uid!==c.u.uid||m.role!==c.m.role||m.enabled!==true||m.entitlementEpoch!==e.epoch||(m.expiresAtMs!==null&&m.expiresAtMs<=time)||m.issuedAtMs>time||e.issuedAtMs>time||e.notBeforeMs>time||(e.expiresAtMs!==null&&e.expiresAtMs<=time))fail('invalid-license');
  integer(e.epoch,1);integer(e.maxDevices,1,1000);if(e.trial)fail('invalid-license');
  await db.runTransaction(async tx=>{const latest=await transactionAuthority(tx,c,request.data,{license:false,manager:true}),t=latest.t;if(t.entitlementPayload&&e.epoch===t.entitlementEpoch&&canonical(e)!==canonical(t.entitlementPayload))fail('stale-license');if(e.epoch<(t.entitlementEpoch||1))fail('stale-license');if(e.epoch===(t.entitlementEpoch||1)&&e.licenseId!==t.licenseId)fail('stale-license');
   tx.update(c.root.collection('members').doc(c.u.uid),{epoch:Math.max(latest.m.epoch||1,m.epoch)});tx.update(c.root,{licenseId:e.licenseId,entitlementEpoch:e.epoch,entitlementPayload:e,paidUntilMs:e.expiresAtMs,perpetual:e.expiresAtMs===null,maxDevices:e.maxDevices,enabled:true});tx.set(c.root.collection('audit').doc('license_'+hash(e)),{action:'activate-license',actorUid:c.u.uid,atMs:time,licenseId:e.licenseId,epoch:e.epoch});});
  return {status:'accepted',serverTimeMs:time};
 }
 async function setMemberActive(request){
  keys(request.data,['tenantId','deviceId','sessionToken','uid','employeeId','active']);const c=await authority(request,{manager:true});
  const byEmployee=request.data.employeeId!==undefined;if(byEmployee=== (request.data.uid!==undefined))fail('invalid-argument');
  if(byEmployee)id(request.data.employeeId);else id(request.data.uid);if(typeof request.data.active!=='boolean')fail('invalid-argument');
  const targetUid=await db.runTransaction(async tx=>{
   await transactionAuthority(tx,c,request.data,{manager:true});let uid=request.data.uid;
   if(byEmployee){
    const [accountSnap,members]=await Promise.all([tx.get(c.root.collection('employeeAccounts').doc(request.data.employeeId)),tx.get(c.root.collection('members').where('employeeId','==',request.data.employeeId).limit(2))]);
    if(members.docs.length!==1)fail('employee-account-not-linked');uid=members.docs[0].id;const account=accountSnap.data();if(account?.uid&&account.uid!==uid)fail('permission-denied');
   }
   const ref=c.root.collection('members').doc(uid),m=(await tx.get(ref)).data();
   if(!m||m.role!=='employee'||(byEmployee&&m.employeeId!==request.data.employeeId))fail('permission-denied');
   tx.update(ref,{active:request.data.active,epoch:(m.epoch||1)+1});tx.set(c.root.collection('audit').doc(random()),{action:'member-active',actorUid:c.u.uid,targetUid:uid,...(m.employeeId?{employeeId:m.employeeId}:{}),active:request.data.active,atMs:now()});return uid;
  });
  await auth.revokeRefreshTokens(targetUid);return {status:'accepted'};
 }
 async function createEmployeeInvitation(request){
  keys(request.data,['tenantId','deviceId','sessionToken','uid','employeeId']);const c=await authority(request,{manager:true}),time=now();
  const invitationToken=await issueEmployeeInvitation({db,auth,tenantId:c.root.id,uid:request.data.uid,employeeId:request.data.employeeId,actor:{uid:c.u.uid,deviceId:request.data.deviceId},now:time});
  return {invitationToken,tenantId:c.root.id,...(request.data.uid!==undefined?{uid:request.data.uid}:{}),employeeId:request.data.employeeId,expiresAtMs:time+7*86400000};
 }
 return {bootstrap,syncOperation,pullChanges,activateLicense,setMemberActive,createEmployeeInvitation,authority,identity};
}
