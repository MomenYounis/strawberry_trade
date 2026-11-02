import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchiveProjection} from '../src/archive-projection.mjs';
import {createActiveSnapshotProjection} from '../src/active-snapshot-projection.mjs';
import {firestoreArchiveSourceFactory} from '../src/archive-coordinator.mjs';
import {createActiveSnapshotPackage} from '../src/active-snapshot-service.mjs';

const tenantId='synthetic_seed',scope={snapshotId:'seed',tenantId,uid:'manager',role:'manager',membershipEpoch:1,checkpointSequence:2,historyFloor:0};
const change=(sequence,entity,payload)=>({sequence,entity,id:payload.id,payload:{tenantId,...payload}});
const changes=[change(1,'party',{id:'customer',kind:'merchant',name:'Synthetic',phone:'',favorite:false,openingMinor:0,revision:1}),
 change(2,'entry',{id:'invoice',kind:'sale',date:'2027-08-31',partyId:'customer',qtyMilli:1000,priceMinor:2000000,totalMinor:2000000,paidMinor:0,unit:'kg',grade:'A',note:''}),
 change(3,'entry',{id:'payment',kind:'merchant_payment',date:'2027-09-02',partyId:'customer',totalMinor:500000,paidMinor:500000,note:''})];
const context={tenantId,runId:'annual_2027',year:2027,closingSequence:3,closingVersion:2};
test('next annual close reconstructs the same controls after prefix removal from verified manager snapshot plus deltas',async()=>{
 const first=await createActiveSnapshotProjection({scope}),objects=new Map();let restored,seeded,full;
 try{
  await first.ingest(changes.slice(0,2));
  const publication=await createActiveSnapshotPackage({projection:first,writePage:async(index,bytes)=>{objects.set(index,JSON.parse(bytes));return {key:`synthetic/${index}`};}});
  restored=await createActiveSnapshotProjection({scope:{...scope,snapshotId:'restore',checkpointSequence:3,historyFloor:2},
   seed:{header:publication.header,expectedHeaderSha256:publication.headerSha256,readPage:async index=>objects.get(index)}});
  await restored.ingest(changes.slice(2));
  seeded=await createArchiveProjection({context,seed:restored});await seeded.ingest([]);
  full=await createArchiveProjection({context});await full.ingest(changes);
  const expected=await full.trustedControls();assert.deepEqual(await seeded.trustedControls(),expected);
  assert.equal(expected.accounts.find(a=>a.id==='customer').openingMinor,2000000);
  assert.equal(expected.accounts.find(a=>a.id==='customer').closingMinor,1500000);
  assert.equal(seeded.seedSequence,3);assert.equal(expected.counts.entry,1);
 }finally{await Promise.all([first,restored,seeded,full].filter(Boolean).map(p=>p.destroy()));}
});
test('archive seeding rejects caller-created objects, employee projections and cross-tenant managers',async()=>{
 await assert.rejects(createArchiveProjection({context,seed:{scope,checkpointSequence:2,iterateFullRecords:async function*(){}}}),/verified-manager-snapshot-required/);
 const employee=await createActiveSnapshotProjection({scope:{...scope,role:'employee'}});
 const manager=await createActiveSnapshotProjection({scope});
 try{await employee.ingest(changes.slice(0,2));await manager.ingest(changes.slice(0,2));
  await assert.rejects(createArchiveProjection({context,seed:employee}),/verified-manager-snapshot-required/);
  await assert.rejects(createArchiveProjection({context:{...context,tenantId:'other'},seed:manager}),/verified-manager-snapshot-required/);
 }finally{await employee.destroy();await manager.destroy();}
});

test('Firestore-shaped annual source factory requires a trusted seed below the floor and reads only subsequent deltas',async()=>{
 const queries=[];
 const query=(filters=[])=>({where:(field,op,value)=>query([...filters,[field,op,value]]),orderBy:()=>query(filters),limit:()=>query(filters),get:async()=>{
  queries.push(filters);return {docs:changes.slice(2).filter(row=>filters.every(([field,op,value])=>op==='>'?row[field]>value:row[field]<=value)).map(row=>({data:()=>row}))};
 }});
 const db={doc:()=>({get:async()=>({data:()=>({enabled:true,sequence:3,historyFloor:2})}),collection:()=>query()})};
 await assert.rejects(firestoreArchiveSourceFactory(db)(context),/snapshot-seed-required/);assert.equal(queries.length,0);
 let ownedSeed;
 const source=await firestoreArchiveSourceFactory(db,{seedProvider:async()=>{ownedSeed=await createActiveSnapshotProjection({scope});await ownedSeed.ingest(changes.slice(0,2));return ownedSeed;}})(context);
 try{const controls=await source.trustedControls();assert.equal(controls.accounts.find(a=>a.id==='customer').closingMinor,1500000);
  assert.equal(source.seedSequence,2);assert.deepEqual(queries,[[['sequence','>',2],['sequence','<=',3]]]);
  assert.throws(()=>ownedSeed.checkpointSequence,/not-sealed/);
 }finally{await source.destroy();}
});
