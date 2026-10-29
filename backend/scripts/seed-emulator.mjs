import {readFile} from 'node:fs/promises';
const path=process.argv[2];if(!path)throw Error('Usage: node scripts/seed-emulator.mjs DEVICE_PUBLIC_REQUEST.json. Start npm run emulators first.');
const d=JSON.parse(await readFile(path,'utf8'));const r=await fetch('http://127.0.0.1:8008/seed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId:d.deviceId,publicKeySpki:d.publicKeySpki})});if(!r.ok)throw Error('Local fixture enrollment failed');console.log(await r.text());
