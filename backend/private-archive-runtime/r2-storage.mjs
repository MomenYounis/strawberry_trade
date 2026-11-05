// Private Node transport. No resource creation, deletion, credentials discovery,
// public URLs, scheduler activation or production acceptance is supplied.
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {S3Client,PutObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3';
import {NodeHttpHandler} from '@smithy/node-http-handler';
import {ARCHIVE_LIMITS} from '../src/archive-format.mjs';
import {integer} from '../src/validation.mjs';
import {assertDemoOperatorEnvironment,DEMO_PROJECT_ID} from '../src/demo-operator.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeError=code=>new Error(code);
function objectKey(key){
 if(typeof key!=='string'||key.length>512||!/^archives\/v1\/[A-Za-z0-9_-]+\/\d{4}\/[A-Za-z0-9_-]+\/(chunks|manifests)\/[a-f0-9]{64}$/.test(key))throw safeError('invalid-archive-object-key');
 return key;
}
function optionsCheck({bucket,credentials,timeoutMs}){
 if(typeof bucket!=='string'||bucket.length<3||bucket.length>63||!(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(bucket)))throw safeError('r2-bucket-required');
 if(!credentials||Object.keys(credentials).sort().join('|')!=='accessKeyId|secretAccessKey'||typeof credentials.accessKeyId!=='string'||typeof credentials.secretAccessKey!=='string'||
  !/^[A-Za-z0-9_-]{8,128}$/.test(credentials.accessKeyId)||!/^[A-Za-z0-9_+/=-]{16,256}$/.test(credentials.secretAccessKey))throw safeError('explicit-r2-credentials-required');
 integer(timeoutMs,100,30_000);
}
function createStorage({endpoint,bucket,credentials,timeoutMs=15_000,synthetic=false}){
 optionsCheck({bucket,credentials,timeoutMs});
 const target=new URL(endpoint),ownedCredentials={...credentials};
 const transport=new NodeHttpHandler({connectionTimeout:timeoutMs,requestTimeout:timeoutMs,
  throwOnRequestTimeout:true,socketTimeout:timeoutMs,httpAgent:{keepAlive:false,maxSockets:1},httpsAgent:{keepAlive:false,maxSockets:1}});
 let closed=false,busy=false,activeController=null,responseOverflow=false;
 // Error XML is parsed by the SDK. Bound it before SDK decoding, as well as
 // bounding successful GetObject bodies below. Do not retain provider messages.
 const handler={metadata:transport.metadata,destroy:()=>transport.destroy(),async handle(request,options){
  if(!['GET','PUT'].includes(request.method)||request.hostname!==target.hostname||String(request.port??(target.protocol==='https:'?443:80))!==String(target.port||(target.protocol==='https:'?443:80))||request.protocol!==target.protocol||!request.path.startsWith('/'+bucket+'/archives/v1/'))throw safeError('r2-request-scope');
  const result=await transport.handle(request,options),response=result.response;
  if(response.statusCode>=300&&response.body){
   const raw=response.body;let bytes=0;
   const bounded=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>16_384)responseOverflow=true;done(responseOverflow?safeError('archive-error-response-limit'):null,chunk);}});
   raw.on('error',error=>bounded.destroy(error));bounded.once('close',()=>raw.destroy());
   response.body=raw.pipe(bounded);
  }
  return result;
 }};
 const silent={trace(){},debug(){},info(){},warn(){},error(){}};
 const client=new S3Client({endpoint:target.href,region:'auto',credentials:ownedCredentials,
  forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,requestHandler:handler,logger:silent,
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 const failure=(error,timedOut)=>{
  if(timedOut||['AbortError','TimeoutError'].includes(error?.name))return safeError('archive-storage-timeout');
  if(responseOverflow)return safeError('archive-error-response-limit');
  if(['archive-error-response-limit','archive-download-limit','archive-object-truncated','archive-object-integrity','r2-request-scope'].includes(error?.message))return safeError(error.message);
  const status=error?.$metadata?.httpStatusCode;
  if(status===404)return safeError('archive-object-missing');
  if(status===401||status===403)return safeError('archive-storage-denied');
  if(status===409)return safeError('archive-write-conflict');
  if(status>=300&&status<400)return safeError('archive-storage-redirect-refused');
  return safeError('archive-storage-error');
 };
 async function operation(work){
  if(closed)throw safeError('archive-storage-closed');if(busy)throw safeError('archive-storage-busy');
  busy=true;responseOverflow=false;const controller=new AbortController();activeController=controller;let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try{return await work(controller.signal);}catch(error){throw failure(error,timedOut);}
  finally{clearTimeout(timer);activeController=null;busy=false;}
 }
 async function get(key,maxBytes,signal){
  const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:signal}),body=result.Body;
  try{
   if(!body||typeof body[Symbol.asyncIterator]!=='function')throw safeError('archive-object-truncated');
   if(result.ContentLength!==undefined&&(!Number.isSafeInteger(result.ContentLength)||result.ContentLength<0||result.ContentLength>maxBytes))throw safeError('archive-download-limit');
   const parts=[];let size=0;
   for await(const value of body){size+=value.length;if(size>maxBytes)throw safeError('archive-download-limit');parts.push(Buffer.from(value));}
   if(result.ContentLength!==undefined&&size!==result.ContentLength)throw safeError('archive-object-truncated');
   const bytes=Buffer.concat(parts,size);if(!key.endsWith('/'+sha(bytes)))throw safeError('archive-object-integrity');return bytes;
  }catch(error){
   if(signal.aborted||['archive-download-limit','archive-object-truncated','archive-object-integrity'].includes(error?.message))throw error;
   throw safeError('archive-object-truncated');
  }finally{body?.destroy?.();}
 }
 return Object.freeze({kind:'node-r2',productionDurabilityAccepted:false,synthetic,
  async putImmutable(key,value){
   objectKey(key);
   if(closed)throw safeError('archive-storage-closed');if(busy)throw safeError('archive-storage-busy');
   if(!(value instanceof Uint8Array)||value.byteLength>ARCHIVE_LIMITS.maxManifestBytes||!key.endsWith('/'+sha(value)))throw safeError('invalid-content-address');
   // Copy before the first await: the caller cannot mutate a Buffer while its
   // content address, Content-MD5 and signed HTTP request are in flight.
   const bytes=Buffer.from(value);
   return operation(async signal=>{
    try{await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentLength:bytes.length,
     ContentType:'application/octet-stream',ContentMD5:createHash('md5').update(bytes).digest('base64'),IfNoneMatch:'*'}),{abortSignal:signal});}
    catch(error){
     if(error?.$metadata?.httpStatusCode!==412)throw error;
     const existing=await get(key,bytes.length,signal);
     if(!existing.equals(bytes))throw safeError('archive-object-integrity');
    }
    return {key};
   });
  },
  async read(key,{maxBytes}){objectKey(key);integer(maxBytes,1,ARCHIVE_LIMITS.maxManifestBytes);return operation(signal=>get(key,maxBytes,signal));},
  close(){if(closed)return;closed=true;activeController?.abort();client.destroy();ownedCredentials.accessKeyId='';ownedCredentials.secretAccessKey='';},
 });
}

export function createNodeR2ArchiveStorage({accountId,bucket,credentials,timeoutMs}){
 if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId))throw safeError('r2-account-required');
 return createStorage({endpoint:`https://${accountId}.r2.cloudflarestorage.com`,bucket,credentials,timeoutMs});
}

// The HTTP exception exists only for a marked demo environment and a numeric
// loopback endpoint. It does not accept custom remote URLs or production IDs.
export function createSyntheticNodeR2ArchiveStorage({endpoint,environment=process.env,...options}){
 assertDemoOperatorEnvironment(DEMO_PROJECT_ID,environment);
 if(!options.credentials?.accessKeyId?.startsWith('synthetic-')||!options.credentials?.secretAccessKey?.startsWith('synthetic-'))throw safeError('synthetic-r2-credentials-required');
 const target=new URL(endpoint);
 if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/'||target.username||target.password||target.search||target.hash)throw safeError('synthetic-r2-loopback-required');
 return createStorage({...options,endpoint:target.href,synthetic:true});
}
