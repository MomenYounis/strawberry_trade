// Actual encrypted preparation and streamed private Node job at annual volume.
import assert from 'node:assert/strict';import {createSyntheticDirectoryStorage} from '../src/synthetic-directory-storage.mjs';
import {ArchiveStateStore,SyntheticArchiveStateAdapter} from '../src/archive-state.mjs';import {prepareArchiveSourceStep,preparedArchiveSourceFactory} from '../src/archive-source-preparation.mjs';import {runPreparedArchiveJob} from '../src/archive-prepared-job.mjs';
assert.ok(process.argv.length<=3&&(!process.argv[2]||/^--records=[1-9][0-9]{0,5}$/.test(process.argv[2])),'bounded synthetic record count required');
const count=process.argv[2]?Number(process.argv[2].slice('--records='.length)):73000;
assert.ok(Number.isSafeInteger(count)&&count>=1&&count<=100000,'synthetic scale limit exceeded');
const tenantId='prepared_scale',year=2026,time=Date.parse('2027-09-02T00:00:00Z');
const stateStore=new ArchiveStateStore(new SyntheticArchiveStateAdapter({[tenantId]:{enabled:true,sequence:count+1}}),{now:()=>time});
await stateStore.create({tenantId,year,runId:'annual_scale'});const lease=await stateStore.acquire(tenantId,year,'scale');await stateStore.checkpoint(tenantId,year,lease,{authorizedClose:true,exportEnabled:true});
let queries=0,readRecords=0;const source={readState:async()=>({enabled:true,sequence:count+1}),readChanges:async({afterSequence,throughSequence,limit})=>{
 queries++;const page=[];for(let n=afterSequence+1;n<=Math.min(afterSequence+limit,throughSequence);n++){
  const id=n===1?'customer':'invoice_'+n;page.push({sequence:n,entity:n===1?'party':'entry',id,payload:n===1?{id,tenantId,name:'Synthetic scale',kind:'merchant',openingMinor:10000}:{id,tenantId,kind:'sale',date:'2027-08-31',partyId:'customer',partyName:'Synthetic',qtyMilli:1000,priceMinor:100,totalMinor:100,paidMinor:50,unit:'kg',grade:'A',note:'x'.repeat(200)}});
 }readRecords+=page.length;return page;
}};
const storage=await createSyntheticDirectoryStorage(),masterKey=Buffer.alloc(32,73),costs={};const budget={reserve:async({costs:c})=>{for(const [k,v] of Object.entries(c))costs[k]=(costs[k]??0)+v;}};
const options={stateStore,tenantId,year,lease,source,storage,masterKey,keyId:'synthetic_only',budget,now:()=>time};const started=Date.now();
try{
 let result;do{result=await prepareArchiveSourceStep({...options,pageSize:100,maxNewPages:2});}while(result.state!=='prepared');
 const preparedAt=Date.now(),sourceFactory=preparedArchiveSourceFactory(options);
 const outcome=await runPreparedArchiveJob({...options,sourceFactory});assert.equal(outcome.state,'verified');
 const run=await stateStore.read(tenantId,year),controls=run.evidence.verified;
 assert.equal(controls.financialMatch,true);assert.equal(controls.productionDurabilityAccepted,false);
 assert.equal(readRecords,count+1);assert.equal(queries,Math.ceil((count+1)/100));
 assert.ok(process.resourceUsage().maxRSS<512*1024,'private Node 512 MiB runtime envelope exceeded');
 // Inspect authenticated controls independently of the app/backend projection.
 const {readArchiveManifest}=await import('../src/archive-format.mjs');const manifest=await readArchiveManifest({storage,manifestKey:run.manifest.key,manifestSha256:run.manifest.sha256,masterKey,expected:{tenantId,year}});
 assert.equal(manifest.controls.signedReceivablesMinor,10000+count*50);assert.equal(manifest.controls.periodRecordedCashMinor,count*50);
 console.log(JSON.stringify({status:'PASS',synthetic:true,annualEntries:count,sourceQueries:queries,sourceRecordsRead:readRecords,encryptedSourcePages:run.sourcePreparation.pageCount,
  sourcePlainBytes:run.sourcePreparation.sourceBytes,annualChunks:run.exportProgress.chunks.length,financialMatch:true,identitiesMatch:true,
  independentExpectedReceivableMinor:10000+count*50,independentExpectedCashMinor:count*50,
  preparationMs:preparedAt-started,exportAndRestoreMs:Date.now()-preparedAt,maxRSSKiB:process.resourceUsage().maxRSS,costReservations:costs,
  runtime:'private Node 512 MiB envelope; not Worker acceptance',productionAcceptance:false},null,2));

}finally{masterKey.fill(0);await storage.destroy();}
