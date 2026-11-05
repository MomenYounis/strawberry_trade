// Shared trusted test-operator transfer used by the CLI and native acceptance.
// Production invocation is deliberately unavailable without a reviewed operator.
import {assertDemoOperatorEnvironment} from './demo-operator.mjs';
import {validateDevice} from './enrollment.mjs';import {id,fail} from './validation.mjs';
export async function transferDemoDevice({db,auth,request:d,projectId,environment=process.env,now=Date.now}){
 assertDemoOperatorEnvironment(projectId,environment);
 for(const k of ['tenantId','uid','deviceId'])id(d[k]);if(d.revokeDeviceId)id(d.revokeDeviceId);validateDevice(d.publicKeySpki,d.deviceId);
 const user=await auth.getUser(d.uid);if(!user.emailVerified||user.disabled)fail('verified-account-required');const root=db.doc('tenants/'+d.tenantId),time=now();
 await db.runTransaction(async tx=>{
  const [ts,ms,ns,all]=await Promise.all([tx.get(root),tx.get(root.collection('members').doc(d.uid)),tx.get(root.collection('devices').doc(d.deviceId)),tx.get(root.collection('devices').where('active','==',true))]);
  const t=ts.data(),m=ms.data();if(!t||t.enabled!==true||t.adminDeleting||!m?.active||ns.exists)fail('permission-denied');
  const old=d.revokeDeviceId?all.docs.find(x=>x.id===d.revokeDeviceId):null;if(d.revokeDeviceId&&(!old||old.data().uid!==d.uid))fail('permission-denied');
  const count=all.docs.filter(x=>x.data().role===m.role&&x.id!==old?.id).length;
  if(count>=(m.role==='manager'?t.maxDevices:(t.maxEmployeeDevices||5000)))fail('device-limit');
  if(old)tx.update(old.ref,{active:false,revokedAtMs:time});
  tx.create(root.collection('devices').doc(d.deviceId),{id:d.deviceId,deviceId:d.deviceId,tenantId:d.tenantId,uid:d.uid,publicKeySpki:d.publicKeySpki,role:m.role,active:true,enrolledAtMs:time});
  tx.update(root.collection('members').doc(d.uid),{epoch:(m.epoch||1)+1});
  tx.set(root.collection('audit').doc('transfer_'+d.deviceId),{action:'trusted-device-transfer',actorUid:'trusted-operator',uid:d.uid,oldDeviceId:d.revokeDeviceId||null,newDeviceId:d.deviceId,atMs:time});
 });await auth.revokeRefreshTokens(d.uid);
}
