import {readFile} from 'node:fs/promises';import {initializeApp} from 'firebase-admin/app';import {getAuth} from 'firebase-admin/auth';import {getFirestore} from 'firebase-admin/firestore';
import {runDemoOperator} from '../src/demo-operator.mjs';import {transferDemoDevice} from '../src/demo-device-transfer.mjs';
const [path,projectId]=process.argv.slice(2);if(!path||!projectId)throw Error('Usage: transfer-device.mjs REQUEST.json demo-strawberry-flutter; production operations are disabled.');
await runDemoOperator(projectId,async()=>{
 const request=JSON.parse(await readFile(path,'utf8')),app=initializeApp({projectId});
 await transferDemoDevice({db:getFirestore(app),auth:getAuth(app),request,projectId});
 console.log('Transferred device. Tenant trial dates and ledger unchanged; reauthenticate and reissue device-bound package.');
});
