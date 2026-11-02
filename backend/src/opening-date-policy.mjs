import {hash,canonical,id,isoDate,integer} from './validation.mjs';
import {annualInterval} from './archive-calendar.mjs';

/** Owner-selected policy. No missing date is inferred from import time,
 * device time, creation order, or a convenient financial-year boundary. */
export function verifyOpeningDatePlan({tenantId,year,parties,plan}) {
 id(tenantId);const {startDate}=annualInterval(year);
 if(!Array.isArray(parties)||parties.length>10000||!plan||plan.policy!=='dated-openings'||plan.tenantId!==tenantId||plan.year!==year||!Array.isArray(plan.dates)||plan.dates.length>10000)throw Error('opening-date-plan-required');
 id(plan.reviewedByUid);isoDate(plan.reviewedOn);
 integer(plan.checkpointSequence,0,Number.MAX_SAFE_INTEGER);
 const current=new Map();
 for(const p of parties){id(p.id);if(p.tenantId!==tenantId||current.has(p.id))throw Error('opening-plan-scope');integer(p.openingMinor??0,-1000000000000);current.set(p.id,p);}
 const dates=new Map();
 for(const attestation of plan.dates){
  id(attestation.partyId);isoDate(attestation.effectiveDate);
  if(dates.has(attestation.partyId))throw Error('opening-date-duplicate');
  const party=current.get(attestation.partyId);
  if(!party||attestation.partySha256!==hash(party))throw Error('opening-date-facts-changed');
  // A within-period amount is a dated posting, not a start-of-period baseline.
  // Refuse automatic reinterpretation; the owner must approve that migration.
  if(attestation.effectiveDate>startDate)throw Error('opening-requires-dated-posting');
  dates.set(attestation.partyId,attestation.effectiveDate);
 }
 for(const p of parties)if((p.openingMinor??0)!==0&&!dates.has(p.id))throw Error('undated-opening-balance');
 return Object.freeze({policy:'dated-openings',tenantId,year,partiesChecked:parties.length,
  undatedOpeningCount:0,checkpointSequence:plan.checkpointSequence,sha256:hash({partiesSha256:hash(parties),plan:JSON.parse(canonical(plan))})});
}
