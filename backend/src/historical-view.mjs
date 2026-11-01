import {id,integer,fail} from './validation.mjs';
import {annualInterval} from './archive-calendar.mjs';
import {readArchiveManifest,readArchiveChunk} from './archive-format.mjs';

const visibleStates=new Set(['verified','cleanup_pending','pruning','complete']);
const hashPattern=/^[a-f0-9]{64}$/;
function published(run,tenantId,year) {
  if(!run||run.tenantId!==tenantId||run.year!==year||!visibleStates.has(run.state)||
    !run.manifest||!hashPattern.test(run.manifest.sha256)||
    run.evidence?.verified?.manifestSha256!==run.manifest.sha256||
    run.evidence.verified.financialMatch!==true||run.evidence.verified.identitiesMatch!==true) fail('archive-not-published');
  const keyId=run.evidence?.uploaded?.keyId;
  id(keyId);id(run.runId);integer(run.checkpoint?.sequence,0,Number.MAX_SAFE_INTEGER);
  integer(run.checkpoint?.version,1,Number.MAX_SAFE_INTEGER);
  return {year,runId:run.runId,...annualInterval(year),closingSequence:run.checkpoint.sequence,
    closingVersion:run.checkpoint.version,keyId};
}
function publicMetadata(metadata) {
  const {keyId,...safe}=metadata;
  return safe;
}

// Internal service. Its ONLY HTTP entry points are createGateway's manager and
// session-checked listArchives/readArchiveRecord methods. Never expose directly.
// It has no ledger, outbox, import, posting, storage-write or notification API.
export function createHistoricalViewer({catalog,storage,keyResolver,chunksPerRequest=4}) {
  integer(chunksPerRequest,1,8);
  if(!catalog||typeof catalog.get!=='function'||typeof catalog.list!=='function'||
    typeof storage?.read!=='function'||typeof keyResolver!=='function') throw new Error('archive-view-not-configured');
  return Object.freeze({
    async list({tenantId,afterYear=null,limit=20}) {
      id(tenantId);integer(limit,1,20);if(afterYear!==null)integer(afterYear,2026,9999);
      const page=await catalog.list({tenantId,afterYear,limit});
      if(!Array.isArray(page.runs)||page.runs.length>limit)fail('invalid-archive-catalog');
      const archives=[];
      for(const run of page.runs) {
        // Non-published runs are deliberately absent from normal browsing.
        if(!visibleStates.has(run.state))continue;
        archives.push(publicMetadata(published(run,tenantId,run.year)));
      }
      if(page.nextYear!==null)integer(page.nextYear,2026,9999);
      return {archives,nextYear:page.nextYear};
    },
    async readRecord({tenantId,year,recordId,nextChunk=0}) {
      id(tenantId);annualInterval(year);id(recordId);integer(nextChunk,0,1024);
      const run=await catalog.get({tenantId,year}),metadata=published(run,tenantId,year);
      const resolved=await keyResolver({tenantId,keyId:metadata.keyId});
      if(!(resolved instanceof Uint8Array)||resolved.byteLength!==32)fail('archive-key-unavailable');
      // Own a temporary copy; do not erase a shared key-provider cache.
      const masterKey=Buffer.from(resolved);
      try {
        const manifest=await readArchiveManifest({storage,...{manifestKey:run.manifest.key,
          manifestSha256:run.manifest.sha256},masterKey,expected:{tenantId,year,runId:run.runId,
          closingSequence:metadata.closingSequence,closingVersion:metadata.closingVersion,keyId:metadata.keyId}});
        if(nextChunk>manifest.chunks.length)fail('invalid-archive-cursor');
        const end=Math.min(nextChunk+chunksPerRequest,manifest.chunks.length);
        let found=null;
        for(let index=nextChunk;index<end;index++) {
          for(const record of await readArchiveChunk({storage,manifest,masterKey,index})) {
            if(record.type==='entry'&&record.payload.id===recordId) {
              if(found)fail('duplicate-archive-record');
              found={...record.payload,archiveYear:year,archiveRunId:run.runId,archived:true,readOnly:true};
            }
          }
        }
        const archive=publicMetadata(metadata);
        if(found)return {status:'found',record:found,archive};
        if(end<manifest.chunks.length)return {status:'continue',record:null,nextChunk:end,archive};
        return {status:'not_found',record:null,archive};
      } finally {masterKey.fill(0);}
    },
  });
}

// No SDK import or default credentials. The caller supplies its already scoped
// Admin SDK instance. It reads only published archive metadata, never customers.
export function createFirestoreArchiveCatalog(db) {
  const root=tenantId=>db.doc(`tenants/${id(tenantId)}`).collection('archiveRuns');
  return Object.freeze({
    async get({tenantId,year}) {annualInterval(year);const doc=await root(tenantId).doc(String(year)).get();return doc.exists?doc.data():null;},
    async list({tenantId,afterYear,limit}) {
      integer(limit,1,20);let query=root(tenantId).orderBy('year','desc');
      if(afterYear!==null)query=query.where('year','<',integer(afterYear,2026,9999));
      const docs=(await query.limit(limit+1).get()).docs;
      const runs=docs.slice(0,limit).map(doc=>doc.data());
      return {runs,nextYear:docs.length>limit?runs.at(-1).year:null};
    },
  });
}
