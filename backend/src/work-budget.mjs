import {integer,id,canonical} from './validation.mjs';

const resources=Object.freeze({firestoreReads:'America/Los_Angeles',firestoreWrites:'America/Los_Angeles',
  firestoreDeletes:'America/Los_Angeles',workerRequests:'UTC',r2ClassA:'UTC',r2ClassB:'UTC',downloadBytes:'UTC'});
const safeAdd=(a,b)=>{const n=BigInt(a)+BigInt(b);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('archive-budget-overflow');return Number(n);};
function windowKey(resource,now) {
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:resources[resource],year:'numeric',month:'2-digit',day:'2-digit'});
  const p=Object.fromEntries(formatter.formatToParts(new Date(now)).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Shared project/account budget, NOT one independent allowance per tenant.
// Reserve conservative worst-case cost before I/O; uncertainty is never refunded.
// Daily R2 caps are internal throttles, not the provider's monthly billing reset.
export class ArchiveWorkBudget {
  constructor(adapter,{limits={},enabled=false,now=Date.now,headroom=async()=>false}={}) {
    this.adapter=adapter;this.limits={};this.enabled=enabled;this.now=now;this.headroom=headroom;
    for(const [resource,limit] of Object.entries(limits)) {
      if(!Object.hasOwn(resources,resource))throw new Error('unknown-budget-resource');
      this.limits[resource]=integer(limit,0,Number.MAX_SAFE_INTEGER);
    }
  }
  async reserve({tenantId,stepId,costs}) {
    id(tenantId);id(stepId);
    if(!this.enabled)throw new Error('archive-budget-disabled');
    if(!costs||Object.getPrototypeOf(costs)!==Object.prototype||!Object.keys(costs).length)throw new Error('invalid-budget-costs');
    for(const [resource,cost] of Object.entries(costs)) {
      if(!Object.hasOwn(resources,resource)||!Object.hasOwn(this.limits,resource))throw new Error('unbudgeted-resource');
      integer(cost,0,Number.MAX_SAFE_INTEGER);
    }
    // The monitor must use observed remaining quotas/live-trade reserves. No
    // monitor, stale observation, or inability to read usage means defer safely.
    if(await this.headroom()!==true)throw new Error('live-trade-headroom-unverified');
    const now=integer(this.now(),0,8_640_000_000_000_000);
    return this.adapter.transaction(async state=>{
      const usage={...(state.usage??{})},windows={};
      for(const [resource,cost] of Object.entries(costs)) {
        const key=windowKey(resource,now);windows[resource]=key;
        const prior=usage[resource]?.window===key?integer(usage[resource].reserved,0,Number.MAX_SAFE_INTEGER):0;
        const reserved=safeAdd(prior,cost);
        if(reserved>this.limits[resource])throw new Error(`archive-budget-exhausted-${resource}`);
        usage[resource]={window:key,reserved};
      }
      state.usage=usage;state.lastReservationAtMs=now;
      // No tenant payloads or credentials. stepId is diagnostic correlation only;
      // a retry that can repeat I/O must reserve again, not reuse free capacity.
      return {tenantId,stepId,costs:{...costs},windows,reservedAtMs:now};
    });
  }
}

export class FirestoreWorkBudgetAdapter {
  constructor(db,{scopeId='annual_archive_shared'}={}) {id(scopeId);this.ref=db.doc(`operatorArchiveBudgets/${scopeId}`);}
  transaction(fn) {
    return this.ref.firestore.runTransaction(async tx=>{
      const doc=await tx.get(this.ref),state=doc.exists?doc.data():{};
      const before=canonical(state),result=await fn(state);
      if(canonical(state)!==before)tx.set(this.ref,state);
      return result;
    });
  }
}
export class SyntheticWorkBudgetAdapter {
  constructor(){this.state={};this.queue=Promise.resolve();this.kind='synthetic';}
  transaction(fn){const result=this.queue.then(async()=>{const draft=structuredClone(this.state),answer=await fn(draft);this.state=draft;return answer;});this.queue=result.catch(()=>{});return result;}
}
