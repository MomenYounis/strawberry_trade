import test from 'node:test';import assert from 'node:assert/strict';
import {verifyOpeningDatePlan} from '../src/opening-date-policy.mjs';import {hash} from '../src/validation.mjs';
test('dated opening evidence is bound to exact tenant, party facts and year; missing dates never inferred',()=>{
 const party={id:'party',tenantId:'a',openingMinor:12345,revision:1};
 const plan={policy:'dated-openings',tenantId:'a',year:2026,checkpointSequence:10,reviewedByUid:'owner',reviewedOn:'2026-11-02',dates:[{partyId:'party',effectiveDate:'2026-09-01',partySha256:hash(party)}]};
 const verify=(p=plan,parties=[party])=>verifyOpeningDatePlan({tenantId:'a',year:2026,parties,plan:p});
 assert.equal(verify().undatedOpeningCount,0);
 assert.throws(()=>verify({...plan,dates:[]}),/undated/);
 assert.throws(()=>verify(plan,[{...party,openingMinor:12346}]),/facts-changed/);
 assert.throws(()=>verify({...plan,tenantId:'other'}),/plan-required/);
 assert.throws(()=>verify({...plan,dates:[{...plan.dates[0],effectiveDate:'2026-10-01'}]}),/dated-posting/);
 assert.throws(()=>verify({...plan,dates:[{...plan.dates[0],effectiveDate:'2026-02-30'}]}));
});
