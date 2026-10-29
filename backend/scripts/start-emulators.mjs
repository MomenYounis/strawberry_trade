import {generateKeyPairSync,randomBytes} from 'node:crypto';import {writeFile,unlink} from 'node:fs/promises';import {spawn} from 'node:child_process';
import {startSeedHelper} from './seed-helper.mjs';
const {privateKey,publicKey}=generateKeyPairSync('ed25519'),pem=privateKey.export({type:'pkcs8',format:'pem'}),publicPem=publicKey.export({type:'spki',format:'pem'}),kid='emulator-session-only',publicKeys={[kid]:publicKey.export({format:'jwk'}).x};
const secret='.secret.local';await writeFile(secret,'LICENSE_PRIVATE_KEY_PEM='+JSON.stringify(pem)+'\n',{mode:0o600});
// A restarted in-memory server is a new synthetic tenant even on the same phone.
// Existing on-device ledgers/queues are retained in their previous tenant scope.
Object.assign(process.env,{GCLOUD_PROJECT:'demo-strawberry-flutter',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',TEST_FIXTURE_NAMESPACE:randomBytes(12).toString('hex'),LICENSE_PRIVATE_KEY_PEM:pem,LICENSE_PUBLIC_KEY_PEM:publicPem,LICENSE_KEY_ID:kid});
await writeFile('../integration-test-defines.json',JSON.stringify({USE_EMULATORS:'true',EMULATOR_HOST:'10.0.2.2',LICENSE_PUBLIC_KEYS:JSON.stringify(publicKeys)},null,2)+'\n');
console.log('Public-only Flutter compile defines: ../integration-test-defines.json');const helper=startSeedHelper(publicKeys);
const child=spawn('./node_modules/.bin/firebase',['emulators:start','--project','demo-strawberry-flutter'],{env:process.env,stdio:'inherit'});
child.on('exit',async code=>{helper.close();await unlink(secret).catch(()=>{});process.exitCode=code??1;});for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>child.kill(s));
