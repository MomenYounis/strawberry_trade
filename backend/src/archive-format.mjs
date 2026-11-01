import {createHash,createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';
import {canonical,id,integer} from './validation.mjs';
import {annualInterval} from './archive-calendar.mjs';
import {ArchiveControlReader,validateArchiveRecord} from './archive-accounting.mjs';

export const ARCHIVE_FORMAT_VERSION=1;
export const ARCHIVE_LIMITS=Object.freeze({chunkBytes:65_536,maxChunkBytes:131_072,maxManifestBytes:524_288,
  maxChunks:1024,maxTotalBytes:67_108_864,maxRecordBytes:24_000,maxRecords:500_000});
const hex=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function exactKeys(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw new Error('invalid-archive-schema');}
function safeJson(value,depth=0){
  if(depth>20)throw new Error('archive-depth-limit');
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('archive-unsafe-number');
  if(value===null||['string','number','boolean'].includes(typeof value))return;
  if(!value||typeof value!=='object')throw new Error('invalid-archive-json');
  if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)throw new Error('invalid-archive-json');
  for(const [key,child] of Object.entries(value)){
    if(['__proto__','constructor','prototype'].includes(key))throw new Error('invalid-archive-property');
    safeJson(child,depth+1);
  }
}
function parseCanonical(bytes,maxBytes){
  if(bytes.byteLength>maxBytes)throw new Error('archive-byte-limit');
  let value,raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(raw);}catch{throw new Error('invalid-archive-json');}
  safeJson(value);if(canonical(value)!==raw)throw new Error('noncanonical-archive-json');return value;
}
function contextCheck(c){
  exactKeys(c,['tenantId','year','runId','closingSequence','closingVersion','previousCloseHash','keyId','createdAtMs']);
  id(c.tenantId);id(c.runId);id(c.keyId);annualInterval(c.year);integer(c.closingSequence,0,Number.MAX_SAFE_INTEGER);
  integer(c.closingVersion,1,Number.MAX_SAFE_INTEGER);integer(c.createdAtMs,0,8_640_000_000_000_000);
  if(c.previousCloseHash!==null&&!hex.test(c.previousCloseHash))throw new Error('invalid-previous-close-hash');
  return c;
}
function derive(masterKey,context,purpose){
  if(!(masterKey instanceof Uint8Array)||masterKey.byteLength!==32)throw new Error('archive-key-required');
  return Buffer.from(hkdfSync('sha256',masterKey,Buffer.from(`${context.tenantId}/${context.runId}/${context.keyId}`),Buffer.from(`strawberry-archive-v1/${purpose}`),32));
}
function namespace(c){return `archives/v1/${id(c.tenantId)}/${c.year}/${id(c.runId)}`;}
function chunkAad(context,index){return Buffer.from(canonical({version:1,context,index}));}
function seal(plaintext,masterKey,context,index){
  const nonce=randomBytes(12),key=derive(masterKey,context,`chunk/${index}`);
  try{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(chunkAad(context,index));
    return Buffer.concat([nonce,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  }finally{key.fill(0);}
}
function unseal(ciphertext,masterKey,context,index){
  if(ciphertext.byteLength<28)throw new Error('truncated-archive-chunk');
  const bytes=Buffer.from(ciphertext),key=derive(masterKey,context,`chunk/${index}`);
  try{const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(chunkAad(context,index));decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);
  }catch{throw new Error('archive-authentication-failed');}finally{key.fill(0);}
}
function manifestMac(body,masterKey){const key=derive(masterKey,body.context,'manifest');try{return createHmac('sha256',key).update(canonical(body)).digest('hex');}finally{key.fill(0);}}
function compare(a,b){return canonical(a)===canonical(b);}

// Durable resumability requires persisting each onCheckpoint result under the
// fenced run. Restarting replays the bounded immutable source prefix and checks
// its plaintext hashes before reusing stored chunks. No plaintext is persisted.
export async function exportArchive({storage,masterKey,context,records,trustedControls,
  assertLease,onCheckpoint=async()=>{},resume=[],chunkBytes=ARCHIVE_LIMITS.chunkBytes}) {
  contextCheck(context);integer(chunkBytes,1024,ARCHIVE_LIMITS.maxChunkBytes);
  if(typeof assertLease!=='function')throw new Error('fenced-lease-required');
  if(!Array.isArray(resume)||resume.length>ARCHIVE_LIMITS.maxChunks)throw new Error('invalid-resume-checkpoint');
  const controls=new ArchiveControlReader(context),chunks=[];let batch=[],bytes=0,totalBytes=0,recordCount=0;
  async function flush(){
    if(!batch.length)return;
    if(chunks.length>=ARCHIVE_LIMITS.maxChunks)throw new Error('archive-chunk-limit');
    const index=chunks.length,plain=Buffer.from(canonical(batch)),plainSha256=sha(plain);await assertLease();
    let descriptor=resume[index];
    if(descriptor){
      validateChunkDescriptor(descriptor,index,context);
      if(descriptor.plainSha256!==plainSha256||descriptor.plainBytes!==plain.length||descriptor.records!==batch.length)throw new Error('resume-source-mismatch');
      const stored=await storage.read(descriptor.key,{maxBytes:descriptor.cipherBytes});
      if(sha(stored)!==descriptor.cipherSha256)throw new Error('resume-chunk-mismatch');
    }else{
      const encrypted=seal(plain,masterKey,context,index),cipherSha256=sha(encrypted);
      descriptor={index,key:`${namespace(context)}/chunks/${cipherSha256}`,plainSha256,cipherSha256,
        plainBytes:plain.length,cipherBytes:encrypted.length,records:batch.length};
      await storage.putImmutable(descriptor.key,encrypted);
    }
    totalBytes+=descriptor.cipherBytes;if(totalBytes>ARCHIVE_LIMITS.maxTotalBytes)throw new Error('archive-total-byte-limit');
    chunks.push(descriptor);await assertLease();await onCheckpoint({chunks:[...chunks],recordCount});batch=[];bytes=0;
  }
  for await(const record of records){
    safeJson(record);const encoded=Buffer.byteLength(canonical(record));
    if(encoded>ARCHIVE_LIMITS.maxRecordBytes||encoded+2>chunkBytes)throw new Error('archive-record-limit');
    if(batch.length&&bytes+encoded+batch.length+2>chunkBytes)await flush();
    controls.accept(record);batch.push(record);bytes+=encoded;recordCount++;
    if(recordCount>ARCHIVE_LIMITS.maxRecords)throw new Error('archive-record-count-limit');
  }
  await flush();if(resume.length>chunks.length)throw new Error('resume-source-mismatch');
  const calculated=controls.finish();if(!trustedControls||!compare(calculated,trustedControls))throw new Error('source-controls-mismatch');
  const body={version:1,schemaVersion:1,protocolVersion:2,algorithm:'AES-256-GCM+HKDF-SHA256+HMAC-SHA256',
    context,interval:annualInterval(context.year),chunks,recordCount,totalBytes,controls:calculated};
  const envelope={body,mac:manifestMac(body,masterKey)},encoded=Buffer.from(canonical(envelope));
  if(encoded.length>ARCHIVE_LIMITS.maxManifestBytes)throw new Error('archive-manifest-limit');
  const manifestSha256=sha(encoded),manifestKey=`${namespace(context)}/manifests/${manifestSha256}`;
  await assertLease();await storage.putImmutable(manifestKey,encoded);await assertLease();
  return {manifestKey,manifestSha256,recordCount,chunks:chunks.length,totalBytes};
}
function validateChunkDescriptor(d,index,context){
  exactKeys(d,['index','key','plainSha256','cipherSha256','plainBytes','cipherBytes','records']);
  if(d.index!==index||!hex.test(d.plainSha256)||!hex.test(d.cipherSha256)||d.key!==`${namespace(context)}/chunks/${d.cipherSha256}`)throw new Error('invalid-chunk-identity');
  integer(d.plainBytes,2,ARCHIVE_LIMITS.maxChunkBytes);integer(d.cipherBytes,30,ARCHIVE_LIMITS.maxChunkBytes+28);
  if(d.cipherBytes!==d.plainBytes+28)throw new Error('invalid-chunk-size');integer(d.records,1,ARCHIVE_LIMITS.maxRecords);
}

export async function readArchiveManifest({storage,manifestKey,manifestSha256,masterKey,expected}) {
  if(!expected?.tenantId||!Number.isInteger(expected.year)||!hex.test(manifestSha256))throw new Error('trusted-manifest-identity-required');
  id(expected.tenantId);annualInterval(expected.year);
  if(typeof manifestKey!=='string'||manifestKey.length>512||!manifestKey.startsWith(`archives/v1/${expected.tenantId}/${expected.year}/`)||manifestKey!==manifestKey.replaceAll('..','')||!manifestKey.endsWith(`/manifests/${manifestSha256}`))throw new Error('invalid-manifest-path');
  const bytes=await storage.read(manifestKey,{maxBytes:ARCHIVE_LIMITS.maxManifestBytes});
  if(sha(bytes)!==manifestSha256)throw new Error('manifest-integrity-failed');
  const envelope=parseCanonical(bytes,ARCHIVE_LIMITS.maxManifestBytes);exactKeys(envelope,['body','mac']);
  const m=envelope.body;exactKeys(m,['version','schemaVersion','protocolVersion','algorithm','context','interval','chunks','recordCount','totalBytes','controls']);
  contextCheck(m.context);
  if(m.version!==1||m.schemaVersion!==1||m.protocolVersion!==2||m.algorithm!=='AES-256-GCM+HKDF-SHA256+HMAC-SHA256'||!compare(m.interval,annualInterval(m.context.year)))throw new Error('unsupported-archive-format');
  for(const [key,value] of Object.entries(expected))if(!Object.hasOwn(m.context,key)||m.context[key]!==value)throw new Error('wrong-archive-identity');
  if(manifestKey!==`${namespace(m.context)}/manifests/${manifestSha256}`||!hex.test(envelope.mac))throw new Error('invalid-manifest-identity');
  if(!timingSafeEqual(Buffer.from(envelope.mac,'hex'),Buffer.from(manifestMac(m,masterKey),'hex')))throw new Error('manifest-authentication-failed');
  if(!Array.isArray(m.chunks)||m.chunks.length>ARCHIVE_LIMITS.maxChunks)throw new Error('archive-chunk-limit');
  let records=0,total=0;const identities=new Set();
  m.chunks.forEach((d,index)=>{validateChunkDescriptor(d,index,m.context);if(identities.has(d.key))throw new Error('duplicate-chunk');identities.add(d.key);records+=d.records;total+=d.cipherBytes;});
  integer(m.recordCount,0,ARCHIVE_LIMITS.maxRecords);integer(m.totalBytes,0,ARCHIVE_LIMITS.maxTotalBytes);
  if(records!==m.recordCount||total!==m.totalBytes)throw new Error('manifest-count-mismatch');
  // Nonenumerable marker prevents accidentally passing an unauthenticated raw
  // JSON manifest to the restore reader. It is process-local, never persisted.
  Object.defineProperty(m,authenticatedManifest,{value:manifestSha256});
  const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  return freeze(m);
}
const authenticatedManifest=Symbol('authenticated-manifest');

export async function* readArchiveRecords({storage,manifest,masterKey}) {
  if(!manifest?.[authenticatedManifest])throw new Error('authenticated-manifest-required');
  for(let index=0;index<manifest.chunks.length;index++){
    for(const row of await readArchiveChunk({storage,manifest,masterKey,index}))yield row;
  }
}

export async function readArchiveChunk({storage,manifest,masterKey,index}) {
    if(!manifest?.[authenticatedManifest])throw new Error('authenticated-manifest-required');
    integer(index,0,manifest.chunks.length-1);const descriptor=manifest.chunks[index];
    const bytes=await storage.read(descriptor.key,{maxBytes:descriptor.cipherBytes});
    if(bytes.byteLength!==descriptor.cipherBytes||sha(bytes)!==descriptor.cipherSha256)throw new Error('chunk-integrity-failed');
    const plain=unseal(bytes,masterKey,manifest.context,descriptor.index);
    if(plain.byteLength!==descriptor.plainBytes||sha(plain)!==descriptor.plainSha256)throw new Error('plaintext-integrity-failed');
    const rows=parseCanonical(plain,ARCHIVE_LIMITS.maxChunkBytes);
    if(!Array.isArray(rows)||rows.length!==descriptor.records)throw new Error('chunk-record-count-mismatch');
    for(const row of rows){if(Buffer.byteLength(canonical(row))>ARCHIVE_LIMITS.maxRecordBytes)throw new Error('archive-record-limit');validateArchiveRecord(row,manifest.context);}
    return rows;
}

// The sink is an isolated temporary restore store. It must never be the live
// ledger. Aborting/destroying it on every failure is the caller's responsibility.
export async function verifyArchive({storage,manifestKey,manifestSha256,masterKey,expected,trustedControls,sink,now=Date.now}) {
  if(!sink||sink.isolated!==true||typeof sink.append!=='function'||typeof sink.destroy!=='function')throw new Error('isolated-restore-store-required');
  try{
    const manifest=await readArchiveManifest({storage,manifestKey,manifestSha256,masterKey,expected});
    if(!trustedControls||!compare(trustedControls,manifest.controls))throw new Error('trusted-checkpoint-controls-mismatch');
    const reader=new ArchiveControlReader(manifest.context);
    for await(const row of readArchiveRecords({storage,manifest,masterKey})){reader.accept(row);await sink.append(row);}
    const restored=reader.finish();
    if(!compare(restored,trustedControls))throw new Error('restore-financial-or-identity-mismatch');
    return {verifier:'strawberry-restore-v1',manifestSha256,financialMatch:true,identitiesMatch:true,
      verifiedAtMs:now(),storageKind:storage.kind,productionDurabilityAccepted:storage.productionDurabilityAccepted===true,
      tenantId:manifest.context.tenantId,year:manifest.context.year,runId:manifest.context.runId,
      closingSequence:manifest.context.closingSequence,closingVersion:manifest.context.closingVersion,keyId:manifest.context.keyId};
  }finally{await sink.destroy();}
}
