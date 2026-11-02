import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical} from '../src/validation.mjs';
import {ACTIVE_SNAPSHOT_LIMITS as L,snapshotScope,snapshotHash,validateSnapshotHeader,
 validateSnapshotRecord,validateSnapshotPage,parseSnapshotBytes,safeSnapshotJson,snapshotContentHash} from '../src/active-snapshot-format.mjs';

const scope={snapshotId:'source',tenantId:'tenant',uid:'manager',role:'manager',membershipEpoch:1,checkpointSequence:10,historyFloor:0};
const party={entity:'party',sequence:1,payload:{id:'party',tenantId:'tenant',name:'عميل',kind:'merchant',phone:'',openingMinor:-100,revision:1}};
const header=()=>({format:'active_snapshot',version:1,syncProtocolVersion:2,...scope,pageCount:1,recordCount:1,contentSha256:snapshotContentHash([{index:0,sha256:snapshotHash([party]),recordCount:1}])});
const page=()=>({snapshotId:'source',index:0,records:[structuredClone(party)],sha256:snapshotHash([party])});

test('active format requires exact schema, safe integer bounds and scope',()=>{
 assert.deepEqual(snapshotScope(scope),scope);assert.deepEqual(validateSnapshotHeader(header(),{tenantId:'tenant'}),header());
 assert.throws(()=>validateSnapshotHeader({...header(),extra:1}),/invalid-snapshot-schema/);
 const merged=header();delete merged.format;delete merged.historyFloor;merged['format|historyFloor']=1;
 assert.throws(()=>validateSnapshotHeader(merged),/invalid-snapshot-schema/);
 for(const field of ['checkpointSequence','membershipEpoch','historyFloor','recordCount','pageCount'])assert.throws(()=>validateSnapshotHeader({...header(),[field]:Number.MAX_SAFE_INTEGER+1}));
 assert.throws(()=>validateSnapshotHeader({...header(),historyFloor:11}));
 assert.throws(()=>validateSnapshotHeader({...header(),recordCount:0}),/invalid-snapshot-counts/);
 assert.throws(()=>validateSnapshotHeader({...header(),pageCount:2}),/invalid-snapshot-counts/);
 assert.throws(()=>validateSnapshotHeader({...header(),recordCount:11}),/invalid-snapshot-counts/);
 assert.throws(()=>validateSnapshotHeader({...header(),pageCount:0,recordCount:0}),/invalid-snapshot-counts/);
 assert.doesNotThrow(()=>validateSnapshotHeader({...header(),role:'employee',pageCount:0,recordCount:0,contentSha256:snapshotHash([])}));
 assert.throws(()=>validateSnapshotHeader(header(),{uid:'other'}),/wrong-snapshot-scope/);
 assert.throws(()=>validateSnapshotHeader({...header(),syncProtocolVersion:1}),/unsupported-active-snapshot/);
 assert.throws(()=>validateSnapshotHeader({...header(),contentSha256:123}),/invalid-snapshot-counts/);
});

test('active pages reject checksum, sequence, ordering and canonical byte corruption',()=>{
 const good=page();assert.deepEqual(validateSnapshotPage(good,header(),0),good);
 assert.deepEqual(parseSnapshotBytes(Buffer.from(canonical(good)),L.maxPageBytes),good);
 assert.throws(()=>parseSnapshotBytes(Buffer.from(JSON.stringify(good)),L.maxPageBytes),/noncanonical-snapshot-json/);
 assert.throws(()=>parseSnapshotBytes(Uint8Array.of(255),L.maxPageBytes),/invalid-snapshot-json/);
 assert.throws(()=>parseSnapshotBytes(new Uint8Array(10),9),/snapshot-byte-limit/);
 assert.throws(()=>validateSnapshotPage({...good,sha256:'a'.repeat(64)},header(),0),/snapshot-page-integrity/);
 assert.throws(()=>validateSnapshotPage({...good,snapshotId:'other'},header(),0),/wrong-snapshot-page/);
 assert.throws(()=>validateSnapshotPage({...good,records:[party,party]},header(),0),/snapshot-record-order/);
 assert.throws(()=>validateSnapshotRecord({...party,sequence:11},scope));
 assert.throws(()=>validateSnapshotRecord({...party,payload:{...party.payload,tenantId:'other'}},scope),/wrong-snapshot-tenant/);
 assert.throws(()=>validateSnapshotRecord({...party,payload:{...party.payload,name:'x'.repeat(L.maxRecordBytes)}},scope),/snapshot-record-limit/);
});

test('JSON boundaries reject prototypes, sparse arrays, unsafe numbers and depth',()=>{
 for(const value of [undefined,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1,new Date(),[,,]])assert.throws(()=>safeSnapshotJson(value));
 assert.throws(()=>safeSnapshotJson(JSON.parse('{"__proto__":{}}')),/invalid-snapshot-property/);
 let deep=null;for(let index=0;index<22;index++)deep=[deep];assert.throws(()=>safeSnapshotJson(deep),/snapshot-json-limit/);
 assert.doesNotThrow(()=>safeSnapshotJson({value:-Number.MAX_SAFE_INTEGER,empty:[],nested:[true,null,'ع']}));
});

test('employee schema permits only exact sanitized party and own valid submissions',()=>{
 const employee={...scope,uid:'worker',role:'employee'};
 const safe={...party,payload:{id:'party',tenantId:'tenant',name:'عميل',kind:'merchant',phone:'',favorite:false,revision:1}};
 assert.deepEqual(validateSnapshotRecord(safe,employee),safe);
 assert.throws(()=>validateSnapshotRecord(party,employee),/invalid-snapshot-schema/);
 const sub={entity:'submission',sequence:5,payload:{id:'sub',tenantId:'tenant',creatorUid:'worker',employeeId:'e',kind:'delivery',date:'2026-09-01',partyId:'party',partyName:'عميل',qtyMilli:1000,grade:'A',unit:'kg',amountMinor:0,note:'',status:'pending',recordedByUid:'worker',recordedAtMs:1}};
 assert.deepEqual(validateSnapshotRecord(sub,employee),sub);
 assert.throws(()=>validateSnapshotRecord({...sub,payload:{...sub.payload,creatorUid:'other'}},employee),/snapshot-projection-denied/);
 assert.throws(()=>validateSnapshotRecord({...sub,payload:{...sub.payload,unit:''}},employee));
 assert.throws(()=>validateSnapshotRecord({...sub,payload:{...sub.payload,approvedUnitMinor:1}},employee),/invalid-snapshot-submission/);
 assert.throws(()=>validateSnapshotRecord({...party,entity:'entry'},employee),/snapshot-projection-denied/);
});
