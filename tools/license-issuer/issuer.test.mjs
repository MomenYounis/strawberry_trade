import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalJson, rawPublicKey, verifyEnvelope, signPackage, verifyPackage, TRIAL_MS } from './issuer.mjs';
const key = generateKeyPairSync('ed25519');
const now = 1700000000000;
const entitlement = {type:'entitlement',version:1,tenantId:'tenant-a',licenseId:'license-a',epoch:1,issuedAtMs:now,notBeforeMs:now,expiresAtMs:now+TRIAL_MS,trialStartMs:now,trial:true,maxDevices:2};
const membership = {type:'membership',version:1,tenantId:'tenant-a',uid:'manager-a',deviceId:'device-a',role:'manager',epoch:1,entitlementEpoch:1,issuedAtMs:now,expiresAtMs:null,enabled:true};
test('canonical JSON sorts nested keys and rejects unsafe/fractional numbers', () => {
  assert.equal(canonicalJson({z:[{b:2,a:1}],a:'عربي'}),'{'+'"a":"عربي","z":[{"a":1,"b":2}]}');
  for (const value of [NaN,Infinity,1.5,9007199254740992,undefined]) assert.throws(()=>canonicalJson({value}));
});
test('Ed25519 round trip uses raw32 public key and canonical signed bytes', () => {
  const signed = signPackage(entitlement,membership,key.privateKey,'test-only');
  assert.equal(Buffer.from(rawPublicKey(key.privateKey),'base64url').length,32);
  assert.deepEqual(verifyPackage(signed,key.publicKey,'test-only'),{entitlement,membership});
});
test('modified payload, signature, unknown key and envelope fields are rejected', () => {
  const signed = signPackage(entitlement,membership,key.privateKey,'test-only');
  for (const changed of [
    {...signed.entitlement,payload:Buffer.from(canonicalJson({...entitlement,maxDevices:999})).toString('base64url')},
    {...signed.entitlement,signature:Buffer.alloc(64).toString('base64url')},
    {...signed.entitlement,kid:'attacker'}, {...signed.entitlement,other:true},
    {...signed.entitlement,payload:signed.entitlement.payload+'='},
  ]) assert.throws(()=>verifyEnvelope(changed,key.publicKey,'test-only'));
});
test('trial exact boundary, schema, tenant and entitlement mismatch are rejected', () => {
  for (const l of [{...entitlement,expiresAtMs:entitlement.expiresAtMs+1},{...entitlement,extra:true},{...entitlement,maxDevices:0}]) assert.throws(()=>signPackage(l,membership,key.privateKey,'test-only'));
  assert.throws(()=>signPackage(entitlement,{...membership,tenantId:'tenant-b'},key.privateKey,'test-only'));
  assert.throws(()=>signPackage(entitlement,{...membership,entitlementEpoch:2},key.privateKey,'test-only'));
});
test('paid perpetual or chosen expiry does not invent trial/renewal policy', () => {
  const l={...entitlement,trial:false,trialStartMs:null,expiresAtMs:null};
  assert.equal(verifyPackage(signPackage(l,membership,key.privateKey,'test-only'),key.publicKey,'test-only').entitlement.expiresAtMs,null);
});
test('CLI encrypted keygen/sign/verify enforces external registry, device cap and transfer', () => {
  const dir=mkdtempSync(join(tmpdir(),'strawberry-issuer-test-'));
  try {
    const privatePath=join(dir,'issuer.pem'),publicPath=join(dir,'public.json'),registry=join(dir,'registry.json');
    const env={...process.env,LICENSE_KEY_PASSPHRASE:'isolated test passphrase more than twenty chars'};
    const cli=(...args)=>spawnSync(process.execPath,['tools/license-issuer/cli.mjs',...args],{cwd:new URL('../../',import.meta.url),env,encoding:'utf8'});
    let r=cli('keygen','--private',privatePath,'--public',publicPath,'--kid','test-only');assert.equal(r.status,0,r.stderr);
    assert.match(readFileSync(privatePath,'utf8'),/ENCRYPTED PRIVATE KEY/);
    assert.doesNotThrow(()=>createPrivateKey({key:readFileSync(privatePath),passphrase:env.LICENSE_KEY_PASSPHRASE}));
    const input=join(dir,'input.json');
    const l={...entitlement,maxDevices:1};
    writeFileSync(input,JSON.stringify({entitlement:l,membership}));
    const sign=(output,...extras)=>cli('sign','--private',privatePath,'--registry',registry,'--input',input,'--output',join(dir,output),'--kid','test-only',...extras);
    r=sign('one.json');assert.equal(r.status,0,r.stderr);
    r=cli('verify','--public',publicPath,'--input',join(dir,'one.json'));assert.equal(r.status,0,r.stderr);
    writeFileSync(input,JSON.stringify({entitlement:l,membership:{...membership,deviceId:'device-b'}}));
    r=sign('two.json');assert.notEqual(r.status,0);assert.match(r.stderr,/device limit/);
    r=sign('two.json','--replace-device','device-a');assert.equal(r.status,0,r.stderr);
    const devices=JSON.parse(readFileSync(registry)).tenants['tenant-a'].devices;
    assert.equal(devices.find(d=>d.id==='device-a').enabled,false);
    assert.equal(devices.find(d=>d.id==='device-b').enabled,true);
    writeFileSync(input,JSON.stringify({entitlement:l,membership}));
    r=sign('replay.json');assert.notEqual(r.status,0);assert.match(r.stderr,/Membership rollback/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('CLI registry cannot restart a tenant trial or replace paid authority with a trial', () => {
  const dir=mkdtempSync(join(tmpdir(),'strawberry-issuer-trial-test-'));
  try {
    const privatePath=join(dir,'issuer.pem'),publicPath=join(dir,'public.json'),registry=join(dir,'registry.json'),input=join(dir,'input.json');
    const env={...process.env,LICENSE_KEY_PASSPHRASE:'isolated trial test passphrase more than twenty chars'};
    const cli=(...args)=>spawnSync(process.execPath,['tools/license-issuer/cli.mjs',...args],{cwd:new URL('../../',import.meta.url),env,encoding:'utf8'});
    let r=cli('keygen','--private',privatePath,'--public',publicPath,'--kid','test-only');assert.equal(r.status,0,r.stderr);
    const sign=(l,m,name)=>{
      writeFileSync(input,JSON.stringify({entitlement:l,membership:m}));
      return cli('sign','--private',privatePath,'--registry',registry,'--input',input,'--output',join(dir,name),'--kid','test-only');
    };
    r=sign(entitlement,membership,'trial.json');assert.equal(r.status,0,r.stderr);
    const reset={...entitlement,epoch:2,issuedAtMs:now+TRIAL_MS,notBeforeMs:now+TRIAL_MS,trialStartMs:now+TRIAL_MS,expiresAtMs:now+TRIAL_MS*2};
    r=sign(reset,{...membership,epoch:2,entitlementEpoch:2},'reset.json');assert.notEqual(r.status,0);assert.match(r.stderr,/trial cannot restart/);
    const paid={...entitlement,epoch:2,trial:false,trialStartMs:null,expiresAtMs:null};
    r=sign(paid,{...membership,epoch:2,entitlementEpoch:2},'paid.json');assert.equal(r.status,0,r.stderr);
    r=sign({...entitlement,epoch:3},{...membership,epoch:3,entitlementEpoch:3},'back-to-trial.json');assert.notEqual(r.status,0);assert.match(r.stderr,/trial cannot restart/);
    assert.equal(JSON.parse(readFileSync(registry)).tenants['tenant-a'].epoch,2);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('CLI refuses an external-looking symlink that would create a private key in client files', () => {
  const dir=mkdtempSync(join(tmpdir(),'strawberry-issuer-path-test-'));
  // The target is an existing client directory; rejected output must never be
  // created, even under a new, nonexistent nested parent of the symlink.
  const name=`.issuer-path-regression-${process.pid}`;
  try {
    const client=new URL('../../',import.meta.url).pathname;
    symlinkSync(client,join(dir,'client-link'),'dir');
    const env={...process.env,LICENSE_KEY_PASSPHRASE:'isolated path test passphrase more than twenty chars'};
    const r=spawnSync(process.execPath,['tools/license-issuer/cli.mjs','keygen','--private',join(dir,'client-link',name,'private.pem'),'--public',join(dir,'public.json'),'--kid','test-only'],{cwd:new URL('../../',import.meta.url),env,encoding:'utf8'});
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/outside the client project/);
    assert.equal(existsSync(join(client,name)),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
