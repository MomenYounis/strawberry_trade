import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpGateway, HTTP_METHODS, decodeCallable} from '../src/http-gateway.mjs';
import {GatewayError} from '../src/validation.mjs';

const appId = '1:123456789:android:abc123';
function fixture(overrides = {}) {
  const calls = [];
  const gateway = Object.fromEntries(HTTP_METHODS.map(name => [name, async request => {
    calls.push({kind: 'gateway', name, request});
    return {status: 'accepted', uid: request.auth.uid, data: request.data};
  }]));
  const config = {
    projectId: 'test-gateway-prod', expectedAppId: appId, gateway,
    auth: {verifyIdToken: async (token, checkRevoked) => {
      calls.push({kind: 'auth', token, checkRevoked});
      return {uid: 'verified_uid', auth_time: 100};
    }},
    appCheck: {verifyToken: async token => {
      calls.push({kind: 'appcheck', token}); return {appId, token: {sub: appId}};
    }},
    ...overrides,
  };
  return {handler: createHttpGateway(config), calls, gateway, config};
}
function request({path = 'bootstrap', headers = {}, data = {}, body, method = 'POST'} = {}) {
  return new Request('https://gateway.example/' + path, {
    method, headers: {'content-type': 'application/json', authorization: 'Bearer valid.jwt',
      'x-firebase-appcheck': 'valid.appcheck', ...headers},
    ...(method === 'GET' ? {} : {body: body ?? JSON.stringify({data})}),
  });
}

test('external callable uses verified identity and preserves native Long payload values', async () => {
  const {handler, calls} = fixture();
  const response = await handler(request({data: {
    auth: {uid: 'spoofed'}, totalMinor: {'@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '3000000000'},
  }}));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = (await response.json()).result;
  assert.equal(value.uid, 'verified_uid'); assert.equal(value.data.totalMinor, 3000000000);
  assert.deepEqual(calls.map(c => c.kind), ['appcheck', 'auth', 'gateway']);
  assert.equal(calls[1].checkRevoked, true);
  assert.equal(calls[2].request.app.appId, appId);
});

test('missing or invalid App Check cannot reach Auth or the financial gateway', async () => {
  const {handler, calls} = fixture();
  const missing = request({data: {emulator: true}}); missing.headers.delete('x-firebase-appcheck');
  assert.equal((await handler(missing)).status, 401); assert.equal(calls.length, 0);
  const invalid = fixture({appCheck: {verifyToken: async () => {throw Error('private token detail');}}});
  const response = await invalid.handler(request());
  assert.equal(response.status, 401); assert.equal(invalid.calls.length, 0);
  assert.equal(JSON.stringify(await response.json()).includes('private token detail'), false);
});

test('valid attestation for another app and revoked Auth sessions are rejected', async () => {
  const wrong = fixture({appCheck: {verifyToken: async () => ({appId: '1:123456789:web:abc123'})}});
  assert.equal((await wrong.handler(request())).status, 403); assert.equal(wrong.calls.length, 0);
  const revoked = fixture({auth: {verifyIdToken: async () => {throw Error('revoked user');}}});
  assert.equal((await revoked.handler(request())).status, 401);
  assert.equal(revoked.calls.some(c => c.kind === 'gateway'), false);
});

test('only the seven exact routes accept JSON POST; health is read-only and token-free', async () => {
  const {handler, calls} = fixture();
  assert.equal((await handler(request({path: 'createUser'}))).status, 404);
  assert.equal((await handler(request({path: 'bootstrap?override=1'}))).status, 404);
  assert.equal((await handler(request({method: 'GET'}))).status, 400);
  assert.equal((await handler(request({headers: {'content-type': 'text/plain'}}))).status, 400);
  const insecure = new Request('http://gateway.example/health');
  assert.equal((await handler(insecure)).status, 400);
  const health = await handler(request({path: 'health', method: 'GET'}));
  assert.deepEqual(await health.json(), {status: 'ok', protocol: 'strawberry-gateway-v1'});
  assert.equal(calls.length, 0);
});

test('oversized chunked bodies are cancelled and never invoke the domain gateway', async () => {
  const {handler, calls} = fixture(); let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {controller.enqueue(new TextEncoder().encode(' '.repeat(65537)));},
    cancel() {cancelled = true;},
  });
  const req = new Request('https://gateway.example/syncOperation', {
    method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer valid.jwt',
      'x-firebase-appcheck': 'valid.appcheck'}, body: stream, duplex: 'half',
  });
  const response = await handler(req);
  assert.equal(response.status, 400); assert.equal(cancelled, true);
  assert.equal((await response.json()).error.details.reason, 'request-too-large');
  assert.equal(calls.some(c => c.kind === 'gateway'), false);
  assert.equal((await handler(request({headers: {'content-length': '999999'}}))).status, 400);
});

test('strict envelopes, UTF-8/JSON and integer tag limits reject unsafe inputs', async () => {
  const {handler, calls} = fixture();
  for (const body of ['{', '{"data":[],"auth":{}}', '{"data":{ },"auth":{"uid":"spoofed"}}', '{"data":null}', '{"data":{"totalMinor":1e999}}']) {
    assert.equal((await handler(request({body}))).status, 400);
  }
  for (const value of [
    {'@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '9007199254740992'},
    {'@type': 'type.googleapis.com/google.protobuf.UInt64Value', value: '-1'},
    {'@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '1.5'},
    {'@type': 'unknown', value: '1'},
  ]) assert.throws(() => decodeCallable(value), /invalid-argument/);
  let deep = 0; for (let i = 0; i < 45; i++) deep = {deep};
  assert.throws(() => decodeCallable(deep), /invalid-argument/);
  assert.equal(decodeCallable({'@type': 'type.googleapis.com/google.protobuf.Int64Value', value: '-9007199254740991'}), Number.MIN_SAFE_INTEGER);
  assert.equal(calls.some(c => c.kind === 'gateway'), false);
});

test('domain errors preserve callable codes while unexpected errors hide secrets', async () => {
  const fixtureOne = fixture(); fixtureOne.gateway.syncOperation = async () => {throw new GatewayError('license-expired');};
  const refused = await fixtureOne.handler(request({path: 'syncOperation'}));
  assert.equal(refused.status, 400);
  assert.deepEqual((await refused.json()).error, {
    status: 'FAILED_PRECONDITION', message: 'license-expired', details: {reason: 'license-expired'},
  });
  const logged = [];
  const unexpected = fixture({logFailure: record => logged.push(record)});
  unexpected.gateway.bootstrap = async () => {throw Error('PRIVATE PEM AND FINANCIAL DETAILS');};
  const response = await unexpected.handler(request());
  assert.equal(response.status, 500); assert.equal(JSON.stringify(await response.json()).includes('PRIVATE'), false);
  assert.deepEqual(logged, [{errorType: 'Error'}]);
});

test('App Check emulator exemption requires exact demo plus both loopback services', async () => {
  const base = fixture().config;
  assert.throws(() => createHttpGateway({...base, appCheck: undefined}));
  assert.throws(() => createHttpGateway({...base, emulator: true}), /both loopback/);
  assert.throws(() => createHttpGateway({...base, projectId: 'demo-strawberry-flutter', emulator: true,
    emulatorEnvironment: {FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080'}}), /both loopback/);
  const {handler} = fixture({projectId: 'demo-strawberry-flutter', emulator: true, appCheck: undefined,
    emulatorEnvironment: {FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099'}});
  const req = request(); req.headers.delete('x-firebase-appcheck');
  assert.equal((await handler(req)).status, 200);
});

test('database quota and outages remain retryable transport failures with no private details', async () => {
  const {handler, gateway} = fixture();
  for (const [code, status, expected] of [[8, 429, 'RESOURCE_EXHAUSTED'], [14, 503, 'UNAVAILABLE'], [4, 503, 'UNAVAILABLE']]) {
    gateway.syncOperation = async () => {throw Object.assign(Error('PRIVATE Google response'), {code});};
    const response = await handler(request({path: 'syncOperation'}));
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.error.status, expected);
    assert.equal(JSON.stringify(payload).includes('PRIVATE'), false);
    assert.equal(Object.hasOwn(payload, 'result'), false);
  }
});
