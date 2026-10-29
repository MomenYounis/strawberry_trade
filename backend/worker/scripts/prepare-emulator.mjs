/** Generate unusable local fixtures only. Never generate/export a Google key. */
import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync,existsSync} from 'node:fs';
const path=new URL('../.dev.vars.emulator',import.meta.url);
if (existsSync(path)) throw Error('Local fixture file already exists; retain it or remove only that synthetic fixture deliberately.');
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}),issuer=generateKeyPairSync('ed25519');
const account={type:'service_account',project_id:'demo-strawberry-flutter',
  client_email:'synthetic-worker@demo-strawberry-flutter.iam.gserviceaccount.com',
  private_key:rsa.privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const values={FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(account),
  LICENSE_PRIVATE_KEY_PEM:issuer.privateKey.export({type:'pkcs8',format:'pem'}).toString(),
  LICENSE_PUBLIC_KEY_PEM:issuer.publicKey.export({type:'spki',format:'pem'}).toString()};
writeFileSync(path,'# Synthetic loopback fixtures. These are not Google credentials.\n'+
  Object.entries(values).map(([key,value])=>key+'='+(key==='FIREBASE_SERVICE_ACCOUNT_JSON'
    ? "'"+value+"'" : JSON.stringify(value))).join('\n')+'\n',
  {flag:'wx',mode:0o600});
console.log('Prepared synthetic local Worker fixtures; no cloud credential was created.');
