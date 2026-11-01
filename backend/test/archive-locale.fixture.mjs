// Synthetic subprocess fixture: no network, credentials, or repository writes.
import assert from 'node:assert/strict';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {ArchiveControlReader} from '../src/archive-accounting.mjs';
const tenantId='synthetic_locale_tenant';
const context={tenantId,year:2026,runId:'locale_run',closingSequence:3,closingVersion:1,keyId:'synthetic',previousCloseHash:null,createdAtMs:1};
const source=await createArchiveProjection({context});
try{
 await source.ingest(['I','i','J'].map((id,index)=>({id,entity:'party',sequence:index+1,payload:{id,tenantId,name:'Synthetic',kind:'merchant',openingMinor:100}})));
 const controls=await source.trustedControls(),reader=new ArchiveControlReader(context);
 for await(const record of source.records())reader.accept(record);
 const restored=reader.finish();assert.deepEqual(restored,controls);
 process.stdout.write(JSON.stringify({locale:new Intl.DateTimeFormat().resolvedOptions().locale,controls,restored}));
}finally{await source.destroy();}
