// Actual HTTP transport through the official SDK, using synthetic loopback only.
// The local server independently validates the SDK signature and persists bytes.
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createNodeR2ArchiveStorage,createSyntheticNodeR2ArchiveStorage} from '../private-archive-runtime/r2-storage.mjs';
import {MirroredArchiveStorage} from '../src/archive-storage.mjs';
import {annualStorageBudgetModel} from '../src/annual-engine.mjs';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';
import {prepareArchiveSourceStep,preparedArchiveSourceFactory} from '../src/archive-source-preparation.mjs';
import {runPreparedArchiveJob} from '../src/archive-prepared-job.mjs';
import {readArchiveManifest} from '../src/archive-format.mjs';
const environment={GCLOUD_PROJECT:'demo-strawberry-flutter',FIRESTORE_EMULATOR_HOST:'127.0.0.1:18180',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:19199'};
const credentials={accessKeyId:'synthetic-r2-access',secretAccessKey:'synthetic-r2-secret-not-production'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const keyFor=bytes=>'archives/v1/synthetic_tenant/2026/synthetic_run/chunks/'+hash(bytes);
function signature(req,body){
 const parsed=/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(req.headers.authorization??'');
 assert.ok(parsed,'official SDK must send SigV4 Authorization');assert.equal(parsed[1],credentials.accessKeyId);
 const [,access,date,listed,signed]=parsed,headers=listed.split(';');
 assert.ok(headers.includes('host'));assert.ok(headers.includes('x-amz-date'));
 if(req.method==='PUT')assert.ok(headers.includes('if-none-match'),'atomic condition is signed');
 const url=new URL(req.url,'http://'+req.headers.host);
 const escape=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 const query=[...url.searchParams].map(([k,v])=>[escape(k),escape(v)]).sort(([a,b],[c,d])=>a.localeCompare(c)||b.localeCompare(d)).map(([k,v])=>k+'='+v).join('&');
 const canonicalHeaders=headers.map(name=>name+':'+String(req.headers[name]).trim().replace(/\s+/g,' ')+'\n').join('');
 const payload=req.headers['x-amz-content-sha256'];assert.ok(payload==='UNSIGNED-PAYLOAD'||payload===hash(body));
 const request=[req.method,url.pathname,query,canonicalHeaders,listed,payload].join('\n');
 const scope=date+'/auto/s3/aws4_request',toSign=['AWS4-HMAC-SHA256',req.headers['x-amz-date'],scope,hash(request)].join('\n');
 const derived=hmac(hmac(hmac(hmac('AWS4'+credentials.secretAccessKey,date),'auto'),'s3'),'aws4_request');
 assert.equal(hmac(derived,toSign).toString('hex'),signed,'independent canonical-request signature verification');
 if(req.method==='PUT'){
  assert.equal(req.headers['if-none-match'],'*');assert.equal(req.headers['content-md5'],createHash('md5').update(body).digest('base64'));
  assert.equal(Number(req.headers['content-length']),body.length);assert.equal(req.headers['cf-create-bucket-if-missing'],undefined);
 }
}
async function server(directory,{port=0}={}){
 const requests=[];let mode='normal',invalid=null;
 const response=(res,status,code)=>{const body='<Error><Code>'+code+'</Code></Error>';res.writeHead(status,{'content-type':'application/xml','content-length':Buffer.byteLength(body)});res.end(body);};
 const http=createServer(async(req,res)=>{
  try{
   const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>524288)throw Error('fixture-request-limit');parts.push(chunk);}
   const body=Buffer.concat(parts);signature(req,body);
   const url=new URL(req.url,'http://'+req.headers.host),path=url.pathname;
   assert.match(path,/^\/[a-z0-9-]+\/archives\/v1\/synthetic_tenant\/2026\/synthetic_run\/(chunks|manifests)\/[a-f0-9]{64}$/);
   assert.ok(req.method==='PUT'||req.method==='GET');requests.push({method:req.method,path,condition:req.headers['if-none-match']??null});
   const file=join(directory,path.split('/')[1]+'-'+path.split('/').at(-1));
   if(mode==='denied')return response(res,403,'AccessDenied');
   if(mode==='redirect'){res.writeHead(301,{Location:'http://127.0.0.1:1/never'});return res.end();}
   if(mode==='large-error'){res.writeHead(403,{'content-type':'application/xml'});return res.end('x'.repeat(65536));}
   if(mode==='slow'){setTimeout(()=>{if(!res.destroyed)response(res,503,'SlowDown');},500).unref();return;}
   if(mode==='conflict')return response(res,409,'ConditionalRequestConflict');
   if(req.method==='PUT'){
    try{await writeFile(file,body,{flag:'wx',mode:0o600});}
    catch(error){if(error.code==='EEXIST')return response(res,412,'PreconditionFailed');throw error;}
    if(mode==='uncertain-put'){res.destroy();return;}
    res.writeHead(200,{'content-length':'0',etag:'"synthetic"'});return res.end();
   }
   let value;try{value=await readFile(file);}catch(error){if(error.code==='ENOENT')return response(res,404,'NoSuchKey');throw error;}
   if(mode==='oversize-length'){res.writeHead(200,{'content-length':1000000});return res.end(value);}
   if(mode==='oversize-stream'){res.writeHead(200,{'content-type':'application/octet-stream'});res.write(Buffer.alloc(524288));return res.end(Buffer.from('overflow'));}
   if(mode==='truncated'){res.writeHead(200,{'content-length':value.length+10});res.write(value);setImmediate(()=>res.destroy());return;}
   if(mode==='tampered')value=Buffer.from('changed ciphertext');
   res.writeHead(200,{'content-length':value.length,'content-type':'application/octet-stream'});res.end(value);
  }catch(error){invalid=error;res.destroy();}
 });
 await new Promise((done,reject)=>{http.once('error',reject);http.listen({host:'127.0.0.1',port},done);});
 return {endpoint:'http://127.0.0.1:'+http.address().port,requests,setMode:value=>{mode=value;},
  assertValid(){if(invalid)throw invalid;},async close(){http.closeAllConnections();await new Promise(done=>http.close(done));}};
}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'strawberry-private-node-r2-'));let running=await server(directory);const clients=[];
 return {directory,get server(){return running;},storage(options={}){const client=createSyntheticNodeR2ArchiveStorage({endpoint:running.endpoint,bucket:'synthetic-primary',credentials,environment,...options});clients.push(client);return client;},
  async restart(){const port=Number(new URL(running.endpoint).port);running.assertValid();await running.close();running=await server(directory,{port});},
  async destroy(){for(const client of clients)client.close();try{running.assertValid();}finally{await running.close();await rm(directory,{recursive:true,force:true});}}};
}
test('production constructor is inert, fixed to HTTPS R2, rejects missing explicit identity/credentials and exposes no deletion',()=>{
 const options={accountId:'0'.repeat(32),bucket:'synthetic-bucket',credentials};
 for(const change of [{accountId:'https://attacker.invalid'},{bucket:'../escape'},{credentials:null},{credentials:{accessKeyId:undefined,secretAccessKey:'x'.repeat(64)}},{timeoutMs:0}])assert.throws(()=>createNodeR2ArchiveStorage({...options,...change}));
 const storage=createNodeR2ArchiveStorage(options);assert.equal(storage.productionDurabilityAccepted,false);assert.equal(storage.kind,'node-r2');
 assert.deepEqual(Object.keys(storage).sort(),['close','kind','productionDurabilityAccepted','putImmutable','read','synthetic'].sort());
 assert.equal(JSON.stringify(storage).includes(credentials.accessKeyId),false);storage.close();
});
test('HTTP exception refuses unmarked, non-loopback, credential-bearing, redirected or path-prefixed endpoints',()=>{
 const options={endpoint:'http://127.0.0.1:12345',bucket:'synthetic-bucket',credentials,environment};
 for(const endpoint of ['http://localhost:12345','http://127.0.0.1:12345/private','http://127.0.0.1:12345/?x=1','http://user:secret@127.0.0.1:12345','https://storage.invalid'])assert.throws(()=>createSyntheticNodeR2ArchiveStorage({...options,endpoint}));
 assert.throws(()=>createSyntheticNodeR2ArchiveStorage({...options,environment:{...environment,GCLOUD_PROJECT:'live-project'}}),/Local demo/);
 assert.throws(()=>createSyntheticNodeR2ArchiveStorage({...options,credentials:{accessKeyId:'unexpected-live-access',secretAccessKey:'unexpected-live-secret'}}),/synthetic-r2-credentials-required/);
});
test('actual SDK-signed conditional PUT and bounded GET persist across client/server restart; duplicate delivery does not overwrite',async()=>{
 const f=await fixture(),bytes=Buffer.from('synthetic encrypted archive bytes'),key=keyFor(bytes);
 try{
  let storage=f.storage();await storage.putImmutable(key,bytes);await storage.putImmutable(key,bytes);
  assert.deepEqual(await storage.read(key,{maxBytes:bytes.length}),bytes);
  assert.deepEqual(f.server.requests.map(r=>r.method),['PUT','PUT','GET','GET']);
  storage.close();await f.restart();storage=f.storage();assert.deepEqual(await storage.read(key,{maxBytes:bytes.length}),bytes);
  assert.deepEqual(annualStorageBudgetModel(storage),{writeA:1,writeB:1,readB:1});assert.equal(storage.productionDurabilityAccepted,false);
 }finally{await f.destroy();}
});
test('caller Buffer mutation cannot change signed payload; missing object and changed ciphertext are refused',async()=>{
 const f=await fixture(),storage=f.storage(),bytes=Buffer.from('original synthetic encrypted bytes'),before=Buffer.from(bytes),key=keyFor(bytes);
 try{
  const writing=storage.putImmutable(key,bytes);bytes.fill(0);await writing;
  assert.deepEqual(await storage.read(key,{maxBytes:before.length}),before);
  await assert.rejects(storage.read(keyFor(Buffer.from('missing')),{maxBytes:100}),/archive-object-missing/);
  f.server.setMode('tampered');await assert.rejects(storage.read(key,{maxBytes:100}),/archive-object-integrity/);
  await assert.rejects(storage.putImmutable(key,before),/archive-object-integrity/);
 }finally{await f.destroy();}
});
test('declared and streamed oversize are stopped; invalid uploads never reach HTTP transport',async()=>{
 const f=await fixture(),storage=f.storage(),bytes=Buffer.from('synthetic bytes'),key=keyFor(bytes);
 try{
  await storage.putImmutable(key,bytes);
  await assert.rejects(storage.read(key,{maxBytes:bytes.length-1}),/archive-download-limit/);
  for(const mode of ['oversize-length','oversize-stream']){f.server.setMode(mode);await assert.rejects(storage.read(key,{maxBytes:524288}),/archive-download-limit/);}
  const before=f.server.requests.length;
  await assert.rejects(storage.putImmutable(key,Buffer.from('wrong address')),/invalid-content-address/);
  const large=Buffer.alloc(524289);await assert.rejects(storage.putImmutable(keyFor(large),large),/invalid-content-address/);
  await assert.rejects(storage.read('../outside',{maxBytes:10}),/invalid-archive-object-key/);assert.equal(f.server.requests.length,before);
 }finally{await f.destroy();}
});
test('denial, redirect and concurrent conflict return bounded fixed errors without retries or leaking provider text',async()=>{
 const f=await fixture(),storage=f.storage(),bytes=Buffer.from('synthetic denied bytes'),key=keyFor(bytes);
 try{
  for(const [mode,error]of [['denied',/archive-storage-denied/],['redirect',/archive-storage-redirect-refused/],['conflict',/archive-write-conflict/],['large-error',/archive-error-response-limit/]]){
   f.server.setMode(mode);const before=f.server.requests.length;await assert.rejects(storage.putImmutable(key,bytes),error);assert.equal(f.server.requests.length,before+1);
  }
 }finally{await f.destroy();}
});
test('unknown upload outcome remains conditional on retry; exactly one persisted object survives',async()=>{
 const f=await fixture(),storage=f.storage(),bytes=Buffer.from('uncertain synthetic delivery'),key=keyFor(bytes);
 try{
  f.server.setMode('uncertain-put');await assert.rejects(storage.putImmutable(key,bytes),/archive-storage-error|archive-storage-timeout/);
  assert.equal(f.server.requests.length,1,'SDK does not silently retry an unknown write');
  f.server.setMode('normal');await storage.putImmutable(key,bytes);assert.deepEqual(await storage.read(key,{maxBytes:bytes.length}),bytes);
  assert.deepEqual(f.server.requests.map(r=>r.method),['PUT','PUT','GET','GET']);
 }finally{await f.destroy();}
});
test('deadline aborts stalled responses and one in-flight operation bounds transport memory',async()=>{
 const f=await fixture(),storage=f.storage({timeoutMs:100}),bytes=Buffer.from('slow synthetic delivery'),key=keyFor(bytes);
 try{
  f.server.setMode('slow');const start=Date.now(),first=storage.putImmutable(key,bytes);
  await assert.rejects(storage.read(key,{maxBytes:100}),/archive-storage-busy/);
  await assert.rejects(first,/archive-storage-timeout/);assert.ok(Date.now()-start<2000);
  assert.equal(f.server.requests.length,1);storage.close();await assert.rejects(storage.read(key,{maxBytes:100}),/archive-storage-closed/);
 }finally{await f.destroy();}
});
test('mirrored independent Node transports verify both copies and preserve recovery when the primary is unavailable',async()=>{
 const f=await fixture(),primary=f.storage(),recovery=f.storage({bucket:'synthetic-recovery'}),storage=new MirroredArchiveStorage(primary,recovery);
 const bytes=Buffer.from('independently copied synthetic ciphertext'),key=keyFor(bytes);
 try{
  await storage.putImmutable(key,bytes);assert.deepEqual(await storage.readRecovery(key,{maxBytes:bytes.length}),bytes);
  assert.deepEqual(annualStorageBudgetModel(storage),{writeA:2,writeB:4,readB:1});
  primary.close();await assert.rejects(storage.read(key,{maxBytes:bytes.length}),/closed/);assert.deepEqual(await storage.readRecovery(key,{maxBytes:bytes.length}),bytes);
  assert.equal(storage.productionDurabilityAccepted,false);
 }finally{await f.destroy();}
});
test('incomplete response is rejected and its socket is released before a later complete read',async()=>{
 const f=await fixture(),storage=f.storage(),bytes=Buffer.from('synthetic complete object'),key=keyFor(bytes);
 try{
  await storage.putImmutable(key,bytes);f.server.setMode('truncated');
  await assert.rejects(storage.read(key,{maxBytes:100}),/archive-object-truncated/);
  f.server.setMode('normal');assert.deepEqual(await storage.read(key,{maxBytes:100}),bytes);
 }finally{await f.destroy();}
});
test('private annual encrypted preparation, export and independent restore use the actual SDK transport without granting acceptance',async()=>{
 const f=await fixture(),storage=f.storage(),time=Date.parse('2027-09-03T12:00:00Z'),tenantId='synthetic_tenant';
 const store=new ArchiveStateStore(new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:2}}),{now:()=>time});
 const party={id:'customer',tenantId,name:'Synthetic customer',kind:'merchant',openingMinor:2000,revision:1};
 const entry={id:'sale',tenantId,kind:'sale',date:'2027-08-31',partyId:'customer',qtyMilli:1000,priceMinor:500,totalMinor:500,paidMinor:250,unit:'kg',grade:'A',revision:1};
 const rows=[{sequence:1,entity:'party',id:'customer',payload:party},{sequence:2,entity:'entry',id:'sale',payload:entry}];
 const source={readState:async()=>({enabled:true,sequence:2}),readChanges:async({afterSequence,limit})=>rows.filter(row=>row.sequence>afterSequence).slice(0,limit)};
 const masterKey=Buffer.alloc(32,93),budget={reserve:async()=>{}};
 try{
  await store.create({tenantId,year:2026,runId:'synthetic_run'});const lease=await store.acquire(tenantId,2026,'private_node_fixture');
  await store.checkpoint(tenantId,2026,lease,{authorizedClose:true,exportEnabled:true});
  const options={stateStore:store,tenantId,year:2026,lease,source,storage,masterKey,keyId:'synthetic_key',budget,now:()=>time};
  assert.equal((await prepareArchiveSourceStep({...options,pageSize:1,maxNewPages:1})).state,'preparing');
  assert.equal((await prepareArchiveSourceStep({...options,pageSize:1,maxNewPages:1})).state,'prepared');
  assert.equal((await runPreparedArchiveJob({...options,sourceFactory:preparedArchiveSourceFactory(options)})).state,'verified');
  const run=await store.read(tenantId,2026);
  const manifest=await readArchiveManifest({storage,manifestKey:run.manifest.key,manifestSha256:run.manifest.sha256,masterKey,expected:{tenantId,year:2026}});
  assert.equal(manifest.controls.signedReceivablesMinor,2250);assert.equal(manifest.controls.periodRecordedCashMinor,250);
  assert.equal(run.evidence.verified.productionDurabilityAccepted,false);assert.ok(f.server.requests.every(row=>['PUT','GET'].includes(row.method)));
 }finally{masterKey.fill(0);await f.destroy();}
});
