// Heavy trusted gateway runs inside one SQLite Durable Object. The public
// Worker only forwards; Firestore remains the authoritative ledger database.
import './private-stream-debug.mjs';
import './compatibility.mjs';
import {DurableObject} from 'cloudflare:workers';

function unavailable() {
  return Response.json({error:{status:'UNAVAILABLE',message:'gateway-not-configured',
    details:{reason:'gateway-not-configured'}}},{status:503,headers:{'cache-control':'no-store'}});
}

export class TradingGateway extends DurableObject {
  constructor(state,env) {super(state,env);this.bindings=env;}
  async fetch(request) {
    try {
      // Evaluate the Admin SDK inside the Durable Object request budget rather
      // than during script startup. The module is cached after its first load.
      const {workerRuntime}=await import('./runtime.mjs');
      return await workerRuntime(this.bindings).fetch(request);
    } catch (error) {
      if (this.bindings.WORKER_EMULATOR_ONLY === 'true') {
        console.error('local-worker-configuration',{errorType:error?.name||'Unknown',
          code:typeof error?.code==='string'&&/^[a-z/-]{1,80}$/.test(error.code)?error.code:'none'});
      }
      return unavailable();
    }
  }
}

export default {
  async fetch(request,env) {
    try {
      // Fixed object name prevents caller-controlled per-tenant object creation.
      return await env.GATEWAY.getByName('gateway-v1').fetch(request);
    } catch {return unavailable();}
  }
};
