// Local synthetic fixtures only. Never deploy this helper or bind it publicly.
import {createServer} from 'node:http';import {createHash} from 'node:crypto';
import {initializeApp,getApps} from 'firebase-admin/app';import {getAuth} from 'firebase-admin/auth';import {getFirestore} from 'firebase-admin/firestore';
import {provisionTenant,validateDevice} from '../src/enrollment.mjs';
import {id} from '../src/validation.mjs';
function fixtureNamespace(value){if(typeof value!=='string'||!/^[a-f0-9]{24}$/.test(value))throw Error('Invalid local fixture namespace');return value;}
export function validateSeedEnvironment(env){
 if(env.GCLOUD_PROJECT!=='demo-strawberry-flutter'||env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8080'||env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('Local demo emulators required');
 return fixtureNamespace(env.TEST_FIXTURE_NAMESPACE);
}
export function syntheticFixtureIds(deviceId,namespace){
 id(deviceId);fixtureNamespace(namespace);
 const suffix=createHash('sha256').update(deviceId).digest('hex').slice(0,20),uid='android_'+suffix;
 return {uid,tenantId:'android_'+namespace+'_'+suffix,email:uid+'@example.test'};
}
export function startSeedHelper(publicKeys){
 const namespace=validateSeedEnvironment(process.env);
 const app=getApps().find(a=>a.name==='[DEFAULT]')||initializeApp({projectId:'demo-strawberry-flutter'});if(app.options.projectId!=='demo-strawberry-flutter')throw Error('Local demo app required');
 const auth=getAuth(app),db=getFirestore(app);const locks=new Map();
 async function seed(d){validateDevice(d.publicKeySpki,d.deviceId);const {uid,tenantId,email}=syntheticFixtureIds(d.deviceId,namespace),password='Emulator_only_92';
  let user=await auth.getUser(uid).catch(e=>{if(e.code==='auth/user-not-found')return null;throw e;});if(!user)user=await auth.createUser({uid,email,password,emailVerified:true});
  const existing=await db.doc('tenants/'+tenantId).get();if(!existing.exists)await provisionTenant({db,auth,uid,tenantId,name:'منشأة اختبار أندرويد',deviceId:d.deviceId,publicKeySpki:d.publicKeySpki});else{const device=await db.doc('tenants/'+tenantId+'/devices/'+d.deviceId).get();if(!device.exists||device.data().uid!==uid)throw Error('fixture-device-mismatch');}
  return {tenantId,uid,email,password,publicLicenseKeys:publicKeys,projectId:'demo-strawberry-flutter',region:'europe-west1'};
 }
 const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json; charset=utf-8');if(req.method!=='POST'||req.url!=='/seed'){res.writeHead(404);res.end('{}');return;}
  let body='';try{for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('too-large');}const d=JSON.parse(body);if(Object.keys(d).some(k=>!['deviceId','publicKeySpki'].includes(k)))throw Error('fields');
   const key=d.deviceId;let result=locks.get(key);if(!result){result=seed(d);locks.set(key,result);result.finally(()=>locks.delete(key)).catch(()=>{});}res.end(JSON.stringify(await result));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.code||e.message||'seed-failed'}));}});
 server.listen(8008,'127.0.0.1',()=>console.log('Synthetic native-device enrollment: http://127.0.0.1:8008/seed (loopback only)'));return server;
}
