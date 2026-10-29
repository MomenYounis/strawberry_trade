import test from 'node:test';
import assert from 'node:assert/strict';
import {invitationTenant} from '../src/enrollment.mjs';
const token=tenant=>`v2.${Buffer.from(tenant).toString('base64url')}.${'A'.repeat(43)}`;
test('self signup token selects only canonical bounded tenant identifiers; old tokens remain opaque',()=>{
 for(const tenant of ['a','tenant_A-123','a'.repeat(120)])assert.equal(invitationTenant(token(tenant)),tenant);
 assert.equal(invitationTenant('A'.repeat(43)),null);
 for(const value of [null,'',token('a').replace('YQ.','YQ=.'),token('a').slice(0,-1)+'B',token('a')+'.extra',token('../other'),token('منشأة'),token('a'.repeat(121)),`v2.YQ.${'A'.repeat(42)}`,'A'.repeat(241)])assert.throws(()=>invitationTenant(value),/invalid-argument/);
});
