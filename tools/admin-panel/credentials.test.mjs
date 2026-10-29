import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductionClients, assertProductionEnvironment, PROJECT_ID, DATABASE_ID, OPERATOR_EMAIL} from './credentials.mjs';

function fixtures(overrides = {}) {
  const calls = [], state = {};
  class UserRefreshClient {
    constructor(options) { calls.push(['oauth', options]); state.oauth = this; this.credentials = {}; }
    async getAccessToken() { this.credentials.expiry_date = 3601000; return {token: 'test-access-token'}; }
    async refreshTokenNoCache() { throw new Error('secret-token-in-upstream-error'); }
    setCredentials(value) { this.credentials = value; }
  }
  class GoogleAuth { constructor(options) { calls.push(['google-auth', options]); this.options = options; } }
  class Firestore {
    constructor(options) { calls.push(['firestore', options]); this.options = options; }
    async terminate() { calls.push(['terminate']); }
  }
  const dependencies = {
    getAccount() { calls.push(['account-read']); return {user: {email: OPERATOR_EMAIL.toUpperCase()}, tokens: {refresh_token: 'test-existing-refresh-token'}}; },
    firebaseApi: {clientId: () => 'test-public-client', clientSecret: () => 'test-public-client-secret'},
    UserRefreshClient, GoogleAuth, Firestore,
    initializeApp(options, name) { calls.push(['initialize-app', options, name]); state.credential = options.credential; return {options, name}; },
    getAuth: app => ({app}), deleteApp: async () => { calls.push(['delete-app']); },
    readPublicConfiguration: async () => ({FIREBASE_PROJECT_ID: PROJECT_ID, FIREBASE_ANDROID_APP_ID: '1:713439663809:android:c0565e7ada543b0e2b6640', FIREBASE_API_KEY: 'AIza' + 'A'.repeat(35), USE_EMULATORS: false}),
    async fetch(url, options) {
      calls.push(['fetch', url, options]);
      return {ok: true, json: async () => url.includes('signInWithPassword') ? {localId: 'new-user', email: 'new@example.com', idToken: 'private-id-token-test'} : {email: 'new@example.com'}};
    },
    ...overrides,
  };
  return {calls, state, dependencies, create: () => createProductionClients({loadDependencies: () => dependencies, environment: {}, now: () => 1000})};
}

test('explicit production identity and independent Firestore share in-memory OAuth without requesting tokens at startup', async () => {
  const f = fixtures(), clients = await f.create();
  assert.equal(clients.projectId, PROJECT_ID); assert.equal(clients.operatorEmail, OPERATOR_EMAIL);
  const options = f.calls.find(c => c[0] === 'firestore')[1];
  assert.equal(options.projectId, PROJECT_ID); assert.equal(options.databaseId, DATABASE_ID);
  assert.equal(options.servicePath, 'firestore.googleapis.com'); assert.equal(options.ssl, true);
  assert.equal(options.auth.options.authClient, f.state.oauth);
  assert.equal(f.calls.filter(c => c[0] === 'fetch').length, 0);
  assert.equal(Object.hasOwn(clients, 'credential'), false);
  assert.deepEqual(await f.state.credential.getAccessToken(), {access_token: 'test-access-token', expires_in: 3600});
  await clients.close(); await clients.close();
  assert.equal(f.calls.filter(c => c[0] === 'terminate').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'delete-app').length, 1);
  await assert.rejects(f.state.credential.getAccessToken(), {code: 'operator-clients-closed'});
});

test('unsafe emulator, origin, credential, debug and project environment fail before dependency intake', async () => {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_TOKEN_URL', 'FIREBASE_CLIENT_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'NODE_OPTIONS', 'NODE_DEBUG', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'FIREBASE_DEBUG_PATH']) {
    await assert.rejects(createProductionClients({environment: {[key]: 'test-override'}, loadDependencies() { assert.fail('must not load'); }}), {code: 'unsafe-operator-environment'});
  }
  assert.throws(() => assertProductionEnvironment({GOOGLE_CLOUD_PROJECT: 'other-project'}), {code: 'operator-project-mismatch'});
  assert.doesNotThrow(() => assertProductionEnvironment({GOOGLE_CLOUD_PROJECT: PROJECT_ID}));
});

test('wrong local identity or absent refresh token cannot create an Admin app', async () => {
  for (const account of [{user: {email: 'other@example.com'}, tokens: {refresh_token: 'test-existing-refresh-token'}}, {user: {email: OPERATOR_EMAIL}, tokens: {}}]) {
    const f = fixtures({getAccount: () => account});
    await assert.rejects(f.create(), {code: 'operator-login-required'});
    assert.equal(f.calls.some(c => c[0] === 'initialize-app'), false);
  }
});

test('SDK and refresh errors never expose upstream credentials', async () => {
  const f = fixtures(), clients = await f.create();
  await assert.rejects(f.state.oauth.refreshTokenNoCache(), error => error.code === 'operator-session-refresh-failed' && !String(error).includes('secret-token'));
  f.state.oauth.getAccessToken = async () => { throw new Error('secret-token-in-upstream-error'); };
  await assert.rejects(f.state.credential.getAccessToken(), error => error.code === 'operator-session-refresh-failed' && !String(error).includes('secret-token'));
  await clients.close();
  const failed = fixtures({getAuth() { throw new Error('private-credential-in-upstream-error'); }});
  await assert.rejects(failed.create(), error => error.code === 'operator-clients-unavailable' && !String(error).includes('private-credential'));
  assert.equal(failed.calls.some(c => c[0] === 'delete-app'), true);
});

test('invalid or expired OAuth result is refused', async () => {
  for (const result of [{token: ''}, {token: 'test-existing-refresh-token'}, {token: 'test-access-token'}]) {
    const f = fixtures(), clients = await f.create();
    f.state.oauth.getAccessToken = async () => { f.state.oauth.credentials.expiry_date = 1000; return result; };
    await assert.rejects(f.state.credential.getAccessToken(), {code: 'operator-session-refresh-failed'});
    await clients.close();
  }
});

test('verification sends only on explicit call, checks account identity, uses fixed endpoints and returns no token', async () => {
  const f = fixtures(), clients = await f.create();
  assert.deepEqual(await clients.sendVerificationEmail({email: 'new@example.com', password: 'local-password', uid: 'new-user'}), {sent: true});
  const requests = f.calls.filter(c => c[0] === 'fetch');
  assert.equal(requests.length, 2);
  for (const [, url, options] of requests) {
    assert.equal(new URL(url).origin, 'https://identitytoolkit.googleapis.com');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
  }
  assert.equal(JSON.parse(requests[1][2].body).requestType, 'VERIFY_EMAIL');
  assert.equal(JSON.parse(requests[1][2].body).idToken, 'private-id-token-test');
  await clients.close();
});

test('verification rejects wrong project, app, account, invalid input and opaque fetch errors', async () => {
  const values = [
    {readPublicConfiguration: async () => ({FIREBASE_PROJECT_ID: 'wrong'})},
    {readPublicConfiguration: async () => { throw new Error('secret-file-error'); }},
    {fetch: async () => ({ok: true, json: async () => ({localId: 'different-user', email: 'new@example.com', idToken: 'private-id-token-test'})})},
    {fetch: async () => { throw new Error('password-secret-error'); }},
  ];
  for (const override of values) {
    const f = fixtures(override), clients = await f.create();
    await assert.rejects(clients.sendVerificationEmail({email: 'new@example.com', password: 'local-password', uid: 'new-user'}), error => /^verification-/.test(error.code) && !String(error).includes('secret'));
    await clients.close();
  }
  const f = fixtures(), clients = await f.create();
  await assert.rejects(clients.sendVerificationEmail({email: 'bad', password: 'short', uid: ''}), {code: 'verification-input-invalid'});
  assert.equal(f.calls.some(c => c[0] === 'fetch'), false);
  await clients.close();
});
