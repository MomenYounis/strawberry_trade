import {id,integer,fail,canonical} from './validation.mjs';
import {annualInterval} from './archive-calendar.mjs';
import {readArchiveManifest,readArchiveChunk,ARCHIVE_LIMITS} from './archive-format.mjs';

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

export const HISTORICAL_STATEMENT_LIMITS=Object.freeze({responseBytes:1_048_576,fragmentRecords:2048});
function exactStatementInteger(value) {
  const result=BigInt(value);
  if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<BigInt(-Number.MAX_SAFE_INTEGER))fail('archive-statement-overflow');
  return Number(result);
}
function statementAccounts(manifest,partyId) {
  const accounts=manifest.controls?.accounts;
  if(!Array.isArray(accounts)||accounts.length>10_000)fail('archive-statement-controls-invalid');
  const result=[],roles=new Set();
  for(const account of accounts) {
    if(account.id!==partyId||!['merchant','supplier'].includes(account.role))continue;
    if(roles.has(account.role))fail('archive-statement-controls-invalid');roles.add(account.role);
    for(const field of ['openingMinor','periodMinor','closingMinor'])integer(account[field],-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
    if(exactStatementInteger(BigInt(account.openingMinor)+BigInt(account.periodMinor))!==account.closingMinor)fail('archive-statement-controls-invalid');
    result.push({role:account.role,openingMinor:account.openingMinor,periodMinor:account.periodMinor,closingMinor:account.closingMinor});
  }
  return result.sort((a,b)=>a.role<b.role?-1:a.role>b.role?1:0);
}
function directPartyEffect(entry,accounts) {
  const total=BigInt(entry.totalMinor??0),paid=BigInt(entry.paidMinor??0);
  let role,delta;
  switch(entry.kind) {
    case 'sale':role='merchant';delta=total-paid;break;
    case 'purchase':role='supplier';delta=total-paid;break;
    case 'merchant_payment':role='merchant';delta=-paid;break;
    case 'supplier_payment':role='supplier';delta=-paid;break;
    case 'sale_return':role='merchant';delta=paid-total;break;
    case 'purchase_return':role='supplier';delta=paid-total;break;
    case 'balance_adjustment':
      if(accounts.length!==1)fail('archive-statement-ambiguous-role');
      role=accounts[0].role;delta=entry.adjustmentDirection==='increase'?total:-total;break;
    default:fail('archive-statement-effect-unavailable');
  }
  if(!accounts.some(account=>account.role===role))fail('archive-statement-role-mismatch');
  return {role,partyEffectMinor:exactStatementInteger(delta)};
}
function publicationIdentity(run,tenantId,year) {
  const metadata=published(run,tenantId,year);
  return canonical({...metadata,tenantId,key:run.manifest.key,sha256:run.manifest.sha256});
}

function statementChunk(rows,partyId,accounts) {
  const result={partySnapshots:[],openingBaselines:[],entries:[],references:[],reversals:[]};
  const seen=new Set();
  for(const row of rows) {
    const entry=row.payload;
    if(row.type==='snapshot'&&entry.entity==='party'&&entry.id===partyId) {
      if(!accounts.some(a=>a.role===entry.record.kind))fail('archive-statement-role-mismatch');
      result.partySnapshots.push(entry.record);
    } else if(row.type==='opening'&&entry.id===partyId&&['merchant','supplier'].includes(entry.role)) {
      if(!accounts.some(a=>a.role===entry.role&&a.openingMinor===entry.balanceMinor))fail('archive-statement-controls-invalid');
      result.openingBaselines.push({role:entry.role,balanceMinor:entry.balanceMinor});
    } else if(row.type==='entry'&&entry.kind==='reversal') {
      // Reversals have no partyId in the authoritative model. A bounded page
      // cannot look up an arbitrary earlier chunk. Return immutable evidence
      // without inventing its party/effect; clients resolve originalId only
      // after collecting every fragment for the same published manifest.
      result.reversals.push({sequence:row.sequence,entry});
    } else if(['entry','reference'].includes(row.type)&&entry.partyId===partyId) {
      result[row.type==='entry'?'entries':'references'].push({sequence:row.sequence,entry,...directPartyEffect(entry,accounts)});
    } else continue;
    const key=`${row.type}/${row.type==='opening'?entry.role+'/':''}${entry.id}`;
    if(seen.has(key))fail('duplicate-archive-statement-record');seen.add(key);
  }
  return result;
}

// Internal service. Its ONLY HTTP entry points are createGateway's manager and
// session-checked archive methods. Never expose this service directly.
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
      id(tenantId);annualInterval(year);id(recordId);integer(nextChunk,0,ARCHIVE_LIMITS.maxChunks);
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
    async readStatement({tenantId,year,partyId,nextChunk=0,manifestSha256=null}) {
      id(tenantId);annualInterval(year);id(partyId);integer(nextChunk,0,ARCHIVE_LIMITS.maxChunks);
      if(manifestSha256!==null&&(typeof manifestSha256!=='string'||!hashPattern.test(manifestSha256)))fail('invalid-archive-manifest-identity');
      if(nextChunk>0&&manifestSha256===null)fail('archive-statement-identity-required');
      const run=await catalog.get({tenantId,year}),metadata=published(run,tenantId,year);
      // Capture scalar publication values before yielding to a key provider or
      // storage request. Neither caller nor a mutable catalogue cache can swap
      // a pointer midway through a response.
      const identity=publicationIdentity(run,tenantId,year),pointer={...run.manifest};
      if(manifestSha256!==null&&manifestSha256!==pointer.sha256)fail('archive-publication-changed');
      const resolved=await keyResolver({tenantId,keyId:metadata.keyId});
      if(!(resolved instanceof Uint8Array)||resolved.byteLength!==32)fail('archive-key-unavailable');
      const masterKey=Buffer.from(resolved);
      try {
        const manifest=await readArchiveManifest({storage,manifestKey:pointer.key,manifestSha256:pointer.sha256,
          masterKey,expected:{tenantId,year,runId:metadata.runId,closingSequence:metadata.closingSequence,
            closingVersion:metadata.closingVersion,keyId:metadata.keyId}});
        if(nextChunk>manifest.chunks.length)fail('invalid-archive-cursor');
        const accounts=statementAccounts(manifest,partyId);
        const statement={tenantId,partyId,manifestSha256:pointer.sha256,...publicMetadata(metadata),accounts};
        const fragment={fromChunk:nextChunk,toChunkExclusive:nextChunk,totalChunks:manifest.chunks.length,
          partySnapshots:[],openingBaselines:[],entries:[],references:[],reversals:[]};
        let rowCount=0;
        if(accounts.length) {
          const end=Math.min(nextChunk+chunksPerRequest,manifest.chunks.length);
          for(let index=nextChunk;index<end;index++) {
            const part=statementChunk(await readArchiveChunk({storage,manifest,masterKey,index}),partyId,accounts);
            const candidate={...fragment,toChunkExclusive:index+1};let candidateCount=rowCount;
            for(const name of ['partySnapshots','openingBaselines','entries','references','reversals']) {
              candidate[name]=[...fragment[name],...part[name]];candidateCount+=part[name].length;
            }
            // Leave enough space for the finite response envelope. A full
            // chunk either belongs to this page or the next; no skipped rows.
            const bytes=Buffer.byteLength(JSON.stringify({statement,fragment:candidate}))+512;
            if(candidateCount>HISTORICAL_STATEMENT_LIMITS.fragmentRecords||bytes>HISTORICAL_STATEMENT_LIMITS.responseBytes) {
              if(index===nextChunk)fail('archive-statement-fragment-limit');
              break;
            }
            Object.assign(fragment,candidate);rowCount=candidateCount;
          }
        }
        // Clients preserve exact server sequence within fragments. Dates and
        // originalBusinessDate remain distinct; display sorting never changes
        // the period or the accepted financial effect.
        for(const name of ['entries','references','reversals'])fragment[name].sort((a,b)=>a.sequence-b.sequence);
        if(publicationIdentity(await catalog.get({tenantId,year}),tenantId,year)!==identity)fail('archive-publication-changed');
        const hasMore=accounts.length>0&&fragment.toChunkExclusive<manifest.chunks.length;
        return {status:accounts.length?(hasMore?'continue':'complete'):'not_found',archived:true,readOnly:true,
          statement,fragment,nextChunk:hasMore?fragment.toChunkExclusive:null};
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
