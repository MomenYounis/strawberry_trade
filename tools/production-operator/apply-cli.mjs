#!/usr/bin/env node
import {createRequire} from 'node:module';
import {createPrivateKey,randomUUID} from 'node:crypto';
import {open,rename,rm,lstat} from 'node:fs/promises';
import {isAbsolute,dirname} from 'node:path';
import {readEnrollmentRequest,writeNewPlan} from './plan.mjs';
import {applyEnrollment,validateApplication} from './apply.mjs';

const usage='Usage: node apply-cli.mjs --apply --credentials-stdin --project PROJECT --database "(default)" --plan /absolute/plan.json --plan-hash SHA256 --approval /absolute/actual-human-approval.json --receipt /absolute/new-application-receipt.json';
let lockPath,app;
try {
  const args=process.argv.slice(2);
  if (args.length===1&&args[0]==='--help') {console.log(usage+'\nNo default mutation. Approval must record a real, specific human authorization after owner, tenant and physical device are known.');}
  else {
    const flags=new Set(),options={},allowed=new Set(['project','database','plan','plan-hash','approval','receipt']);
    for(let i=0;i<args.length;i++) {
      const key=args[i]?.slice(2);
      if (!args[i]?.startsWith('--')) throw Error();
      if (['apply','credentials-stdin'].includes(key)) {if(flags.has(key))throw Error();flags.add(key);continue;}
      if (!allowed.has(key)||Object.hasOwn(options,key)||!args[i+1]||args[i+1].startsWith('--'))throw Error();options[key]=args[++i];
    }
    if(flags.size!==2||Object.keys(options).length!==allowed.size||['plan','approval','receipt'].some(k=>!isAbsolute(options[k])))throw Error();
    const plan=await readEnrollmentRequest(options.plan),approval=await readEnrollmentRequest(options.approval);
    const input={plan,approval,projectId:options.project,databaseId:options.database,planHashSha256:options['plan-hash'],environment:process.env};
    validateApplication(input); // Runs before SDK loading, credential intake, locking or cloud access.
    let inputBytes=Buffer.alloc(0);
    for await(const chunk of process.stdin) {inputBytes=Buffer.concat([inputBytes,chunk]);if(inputBytes.length>5120)throw Error();}
    const serviceAccount=JSON.parse(inputBytes.toString('utf8'));inputBytes.fill(0);
    if(serviceAccount.type!=='service_account'||serviceAccount.project_id!==options.project||typeof serviceAccount.client_email!=='string')throw Error();
    const key=createPrivateKey(serviceAccount.private_key);
    if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error();
    const lock=options.receipt+'.lock';await writeNewPlan(lock,{kind:'exclusive-local-enrollment-application-lock'});lockPath=lock;
    const receiptStore={
      async read(){try{return await readEnrollmentRequest(options.receipt);}catch(error){if(error.code==='ENOENT')return null;throw error;}},
      async write(value){
        try {const s=await lstat(options.receipt);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw Error();}
        catch(error){if(error.code!=='ENOENT')throw error;}
        const temporary=options.receipt+'.'+randomUUID()+'.tmp';
        await writeNewPlan(temporary,value);
        try {const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}await rename(temporary,options.receipt);
          const directory=await open(dirname(options.receipt),'r');try{await directory.sync();}finally{await directory.close();}}
        finally{await rm(temporary,{force:true});}
      },
    };
    const require=createRequire(new URL('../../backend/package.json',import.meta.url));
    const {initializeApp,cert,deleteApp}=require('firebase-admin/app');
    const {initializeFirestore}=require('firebase-admin/firestore'),{getAuth}=require('firebase-admin/auth');
    app=initializeApp({projectId:options.project,credential:cert(serviceAccount)},'approved-owner-enrollment-'+randomUUID());
    try {console.log(JSON.stringify(await applyEnrollment(input,{db:initializeFirestore(app,{preferRest:true}),auth:getAuth(app),receiptStore})));}
    finally {await deleteApp(app);app=null;}
  }
} catch(error) {
  console.error('Enrollment application refused or incomplete: '+(typeof error.code==='string'&&/^[a-z-]+$/.test(error.code)?error.code:'review-local-approval-and-receipt'));
  process.exitCode=1;
} finally {if(lockPath)await rm(lockPath,{force:true});}
