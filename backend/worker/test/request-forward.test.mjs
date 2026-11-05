import test from 'node:test';
import assert from 'node:assert/strict';
import {forwardGatewayRequest} from '../request-forward.mjs';

test('incoming chunked body is fully consumed before an early authorization response',async()=>{
 let consumed=0,finished=false,forwarded;
 const request=new Request('https://example.test/syncOperation',{method:'POST',duplex:'half',body:new ReadableStream({pull(controller){
  if(consumed===2){finished=true;controller.close();return;}
  consumed++;controller.enqueue(new Uint8Array([consumed]));
 }})});
 const response=await forwardGatewayRequest(request,{fetch:async value=>{assert.equal(finished,true);forwarded=value;return new Response('denied',{status:401});}});
 assert.equal(response.status,401);assert.notEqual(forwarded,request);
 assert.deepEqual([...new Uint8Array(await forwarded.arrayBuffer())],[1,2]);
});

test('oversize declared or chunked requests never reach the DO and cancel the input',async()=>{
 for(const declared of [false,true]){
  let cancelled=false,calls=0;
  const body=new ReadableStream({start(c){if(!declared){c.enqueue(new Uint8Array(32768));c.enqueue(new Uint8Array(32769));}},cancel(){cancelled=true;}});
  const request=new Request('https://example.test/syncOperation',{method:'POST',duplex:'half',body,headers:declared?{'content-length':'65537'}:{}});
  const response=await forwardGatewayRequest(request,{fetch:async()=>{calls++;throw Error('must not forward');}});
  assert.equal(response.status,400);assert.equal((await response.json()).error.details.reason,'request-too-large');assert.equal(calls,0);assert.equal(cancelled,true);
 }
});

test('exact maximum request remains intact and health without a body remains unchanged',async()=>{
 const body=new Uint8Array(65536).fill(7),request=new Request('https://example.test/syncOperation',{method:'POST',body});
 const response=await forwardGatewayRequest(request,{fetch:async value=>{assert.deepEqual(new Uint8Array(await value.arrayBuffer()),body);return new Response('ok');}});assert.equal(response.status,200);
 const health=new Request('https://example.test/health');await forwardGatewayRequest(health,{fetch:async value=>{assert.equal(value,health);return new Response('ok');}});
});
