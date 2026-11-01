// Invoked as a separate constrained-heap process, never a live Firestore client.
import assert from 'node:assert/strict';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {exportArchive,verifyArchive} from '../src/archive-format.mjs';
import {createTemporaryRestoreSink} from '../src/archive-storage.mjs';
import {createSyntheticDirectoryStorage} from '../src/synthetic-directory-storage.mjs';

const count=73000,tenantId='synthetic_annual_scale';
const context={tenantId,year:2026,runId:'scale_73k',closingSequence:count+1,closingVersion:1,previousCloseHash:null,keyId:'synthetic',createdAtMs:1};
const source=await createArchiveProjection({context}),storage=await createSyntheticDirectoryStorage(),masterKey=Buffer.alloc(32,19);
const started=Date.now();
async function* changes(){
 yield {sequence:1,entity:'party',id:'customer',payload:{id:'customer',tenantId,name:'Synthetic scale customer',kind:'merchant',openingMinor:10000}};
 for(let i=0;i<count;i++)yield {sequence:i+2,entity:'entry',id:'invoice_'+i,payload:{id:'invoice_'+i,tenantId,kind:'sale',date:'2027-08-31',partyId:'customer',partyName:'Synthetic',qtyMilli:1000,priceMinor:100,totalMinor:100,paidMinor:50,unit:'kg',grade:'A',note:'x'.repeat(200)}};
}
try {
 await source.ingest(changes());const projectedAt=Date.now();const controls=await source.trustedControls();
 assert.equal(controls.signedReceivablesMinor,10000+count*50);assert.equal(controls.periodRecordedCashMinor,count*50);
 const result=await exportArchive({storage,masterKey,context,records:source.records(),trustedControls:controls,assertLease:async()=>{}});
 const exportedAt=Date.now();
 const evidence=await verifyArchive({storage,...result,masterKey,expected:context,trustedControls:controls,sink:await createTemporaryRestoreSink()});
 assert.equal(evidence.identitiesMatch,true);assert.equal(evidence.productionDurabilityAccepted,false);
 console.log(JSON.stringify({status:'PASS',synthetic:true,annualEntries:count,recordCount:result.recordCount,chunks:result.chunks,cipherBytes:result.totalBytes,
  independentExpectedReceivableMinor:10000+count*50,independentExpectedCashMinor:count*50,
  projectionMs:projectedAt-started,exportMs:exportedAt-projectedAt,verifyMs:Date.now()-exportedAt,
  maxRSSKiB:process.resourceUsage().maxRSS,heapLimitFlag:'--max-old-space-size=96',runtime:'private Node; not Worker acceptance'},null,2));
}finally{await source.destroy();await storage.destroy();masterKey.fill(0);}
