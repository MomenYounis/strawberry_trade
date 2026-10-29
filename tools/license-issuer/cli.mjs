#!/usr/bin/env node
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, openSync, closeSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, rawPublicKey, signPackage, verifyPackage } from './issuer.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Expected unique --option value pairs');
  options[args[i].slice(2)] = args[i + 1];
}
const required = name => { if (!options[name]) throw new Error(`Missing --${name}`); return resolve(options[name]); };
const readJson = path => { const data = readFileSync(path, 'utf8'); if (data.length > 200000) throw new Error('Input too large'); return JSON.parse(data); };
const writeNew = (path, data, mode = 0o600) => { mkdirSync(dirname(path), {recursive:true,mode:0o700}); writeFileSync(path,data,{flag:'wx',mode}); };
const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const external = path => {
  // Resolve existing parent symlinks too: an apparently external directory must
  // not redirect a new private key or issuance registry into client assets.
  let existing=path;
  const remainder=[];
  while (!existsSync(existing)) {
    remainder.unshift(basename(existing));
    const parent=dirname(existing);
    if (parent===existing) throw new Error('Cannot resolve protected output path');
    existing=parent;
  }
  const actual=resolve(realpathSync(existing),...remainder);
  const rel=relative(realpathSync(project),actual);
  if (rel==='' || (!rel.startsWith(`..${sep}`) && rel!=='..' && !isAbsolute(rel))) throw new Error('Private key and registry must be outside the client project');
};
const passphrase = () => {
  const value = process.env.LICENSE_KEY_PASSPHRASE;
  if (!value || value.length < 20) throw new Error('Set LICENSE_KEY_PASSPHRASE to at least 20 characters; do not pass it as an argument');
  return value;
};
try {
  if (command === 'keygen') {
    const privatePath = required('private'), publicPath = required('public'); external(privatePath);
    const kid = options.kid;
    if (!kid || !/^[A-Za-z0-9._-]{1,80}$/.test(kid)) throw new Error('Missing/invalid --kid');
    const pair = generateKeyPairSync('ed25519');
    writeNew(privatePath,pair.privateKey.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:passphrase()}));
    const publicKey = pair.publicKey.export({format:'pem',type:'spki'}).toString();
    writeNew(publicPath,JSON.stringify({kid,publicKey:rawPublicKey(publicKey),spkiPem:publicKey},null,2)+'\n',0o644);
    process.stdout.write(`Created encrypted issuer key; public key id ${kid}.\n`);
  } else if (command === 'sign') {
    const privatePath = required('private'), registryPath = required('registry'); external(privatePath); external(registryPath);
    const request = readJson(required('input'));
    const privateKey = createPrivateKey({key:readFileSync(privatePath),passphrase:passphrase()});
    const signed = signPackage(request.entitlement,request.membership,privateKey,options.kid);
    // A registry serializes issuance on this trusted machine. It is not a server
    // membership authority and cannot replace verified enrollment/ownership checks.
    mkdirSync(dirname(registryPath),{recursive:true,mode:0o700});
    const lockPath = registryPath+'.lock'; const lock = openSync(lockPath,'wx',0o600);
    try {
      const registry = existsSync(registryPath) ? readJson(registryPath) : {version:1,tenants:{}};
      if (registry.version !== 1 || !registry.tenants) throw new Error('Invalid registry');
      const l=request.entitlement,m=request.membership;
      const prior=Object.hasOwn(registry.tenants,l.tenantId) ? registry.tenants[l.tenantId] : {epoch:0,payload:null,devices:[]};
      if (l.epoch < prior.epoch || (l.epoch===prior.epoch && prior.payload!==canonicalJson(l))) throw new Error('Entitlement rollback or same-epoch change');
      if (l.trial && prior.payload!==null) {
        const previousEntitlement=JSON.parse(prior.payload);
        if (!previousEntitlement.trial || l.trialStartMs!==previousEntitlement.trialStartMs || l.expiresAtMs!==previousEntitlement.expiresAtMs) throw new Error('A tenant trial cannot restart or replace a paid entitlement');
      }
      if (options['replace-device']) {
        const replaced=prior.devices.find(d=>d.id===options['replace-device'] && d.enabled!==false);
        if(!replaced || replaced.id===m.deviceId) throw new Error('Transfer source must be another registered active device');
        replaced.enabled=false;replaced.transferred=true;
      }
      const old=prior.devices.find(d=>d.id===m.deviceId);
      if (old && (m.epoch<old.epoch || (m.epoch===old.epoch && (old.payload!==canonicalJson(m) || old.transferred)))) throw new Error('Membership rollback or same-epoch change');
      prior.devices=prior.devices.filter(d=>d.id!==m.deviceId);
      prior.devices.push({id:m.deviceId,uid:m.uid,role:m.role,epoch:m.epoch,enabled:m.enabled,transferred:false,payload:canonicalJson(m)});
      if (prior.devices.filter(d=>d.role==='manager' && d.enabled!==false).length>l.maxDevices) throw new Error('Configured device limit exceeded');
      prior.epoch=l.epoch;prior.payload=canonicalJson(l);Object.defineProperty(registry.tenants,l.tenantId,{value:prior,enumerable:true,writable:true,configurable:true});
      // Reserve state before delivery: a crash may require a retry, never over-issue.
      const temporary=registryPath+'.next';writeFileSync(temporary,JSON.stringify(registry),{mode:0o600});renameSync(temporary,registryPath);
      writeNew(required('output'),JSON.stringify(signed,null,2)+'\n');
    } finally {closeSync(lock);unlinkSync(lockPath);}
    process.stdout.write('Signed package saved. Deliver only to the verified enrolled account/device.\n');
  } else if (command === 'verify') {
    const trusted = readJson(required('public'));
    const verified = verifyPackage(readJson(required('input')),createPublicKey(trusted.spkiPem),trusted.kid);
    process.stdout.write(JSON.stringify(verified,null,2)+'\n');
  } else throw new Error('Commands: keygen --private PATH --public PATH --kid ID | sign --private PATH --registry PATH --input PATH --output PATH --kid ID [--replace-device ID] | verify --public PATH --input PATH');
} catch (error) {
  process.stderr.write(`Issuer error: ${error.message}\n`);process.exitCode=1;
}
