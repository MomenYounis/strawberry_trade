import {readFile} from 'node:fs/promises';
import {initializeApp} from 'firebase-admin/app';import {getAuth} from 'firebase-admin/auth';import {getFirestore} from 'firebase-admin/firestore';
import {provisionTenant} from '../src/enrollment.mjs';
import {runDemoOperator} from '../src/demo-operator.mjs';
const [path,projectId]=process.argv.slice(2);if(!path||!projectId)throw Error('Usage: node scripts/provision-tenant.mjs REQUEST.json PROJECT_ID; requires trusted ADC and verified existing UID.');
await runDemoOperator(projectId,async()=>{
 initializeApp({projectId});const request=JSON.parse(await readFile(path,'utf8'));const result=await provisionTenant({...request,db:getFirestore(),auth:getAuth()});console.log(JSON.stringify(result));
});
