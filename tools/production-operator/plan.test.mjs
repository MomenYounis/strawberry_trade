import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createEnrollmentPlan, readEnrollmentRequest, writeNewPlan} from './plan.mjs';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const projectId = 'strawberry-operator-review', databaseId = '(default)';
const publicBytes = generateKeyPairSync('ec', {namedCurve: 'prime256v1'})
  .publicKey.export({format: 'der', type: 'spki'});
const fixture = () => ({projectId, databaseId, ownerUid: 'existing_verified_owner',
  expectedEmail: 'owner@example.test', tenantId: 'review_business', managerName: 'مالك تجريبي',
  deviceId: createHash('sha256').update(publicBytes).digest('base64url'),
  publicKeySpki: publicBytes.toString('base64url'), maxDevices: 1});
const settings = {projectId, databaseId};
async function temporary(run) {
  const path = await mkdtemp(join(tmpdir(), 'strawberry-operator-plan-'));
  try {return await run(path);} finally {await rm(path, {recursive: true, force: true});}
}
function cleanEnvironment() {
  const env = {...process.env};
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
    'WORKER_EMULATOR_ONLY', 'FIREBASE_EMULATOR_HUB', 'FUNCTIONS_EMULATOR',
    'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'NODE_OPTIONS']) delete env[key];
  return env;
}
function cli(requestPath, extra = [], nodeArguments = [], env = cleanEnvironment()) {
  return spawnSync(process.execPath, [...nodeArguments, join(toolDirectory, 'cli.mjs'),
    '--project', projectId, '--database', databaseId, '--request', requestPath, ...extra],
  {encoding: 'utf8', env});
}

test('review plan states unresolved identity, create-only actions and deferred one-time trial', () => {
  const input = fixture(), before = structuredClone(input);
  const plan = createEnrollmentPlan(input, settings);
  assert.deepEqual(input, before);
  assert.equal(plan.executable, false);
  assert.equal(plan.authorizationGranted, false);
  assert.equal(plan.liveChecksPerformed, false);
  assert.equal(plan.requiredChecksBeforeApplication.every(check => check.status === 'not-performed'), true);
  const [revoke, transaction] = plan.proposedActions;
  assert.equal(revoke.operation, 'revoke-owner-refresh-tokens');
  assert.match(revoke.effect, /old website/);
  assert.match(revoke.atomicity, /can succeed even when the subsequent transaction fails/);
  assert.equal(transaction.documents.length, 4);
  assert.equal(transaction.documents.every(document => document.precondition === 'must-not-exist'), true);
  assert.equal(transaction.clock.durationMs, 2592000000);
  assert.equal(transaction.clock.captureAt, 'approved-application');
  assert.equal(typeof transaction.documents[0].data.trialStartMs, 'string');
  assert.match(plan.requiredChecksBeforeApplication.find(item => item.check === 'tenant-and-history-absent').requirement,
    /must never restart/);
  assert.match(plan.privateKeyProof.requirement, /fresh P-256 challenge/);
  assert.equal(createEnrollmentPlan(fixture(), settings).planHashSha256, plan.planHashSha256);
  assert.notEqual(createEnrollmentPlan({...fixture(), maxDevices: 2}, settings).planHashSha256, plan.planHashSha256);
});

test('rejects malformed, wrong-algorithm, noncanonical and mismatched device requests', () => {
  const ed25519 = generateKeyPairSync('ed25519').publicKey.export({format: 'der', type: 'spki'});
  const wrongCurve = generateKeyPairSync('ec', {namedCurve: 'secp384r1'}).publicKey.export({format: 'der', type: 'spki'});
  for (const bytes of [ed25519, wrongCurve, Buffer.from('not-a-public-key')]) {
    assert.throws(() => createEnrollmentPlan({...fixture(), publicKeySpki: bytes.toString('base64url'),
      deviceId: createHash('sha256').update(bytes).digest('base64url')}, settings), /P-256/);
  }
  assert.throws(() => createEnrollmentPlan({...fixture(), deviceId: 'different_device'}, settings), /P-256/);
  assert.throws(() => createEnrollmentPlan({...fixture(), publicKeySpki: fixture().publicKeySpki + '='}, settings), /P-256/);
  const trailing = Buffer.concat([publicBytes, Buffer.from([0])]);
  assert.throws(() => createEnrollmentPlan({...fixture(), publicKeySpki: trailing.toString('base64url'),
    deviceId: createHash('sha256').update(trailing).digest('base64url')}, settings), /P-256/);
});

test('rejects unknown/omitted fields, incompatible identities and ambiguous values', () => {
  for (const key of Object.keys(fixture())) {
    const request = fixture(); delete request[key];
    assert.throws(() => createEnrollmentPlan(request, settings), /fields/);
  }
  assert.throws(() => createEnrollmentPlan({...fixture(), role: 'manager'}, settings), /fields/);
  for (const patch of [{ownerUid: 'user/other'}, {tenantId: '../legacy'}, {expectedEmail: 'owner@example.test\n'},
    {managerName: ''}, {managerName: ' Owner '}, {maxDevices: 0}, {maxDevices: 1001}, {maxDevices: '1'}]) {
    assert.throws(() => createEnrollmentPlan({...fixture(), ...patch}, settings));
  }
});

test('requires matching explicit project/default database and refuses all emulator markers', () => {
  assert.throws(() => createEnrollmentPlan(fixture()), /project/);
  assert.throws(() => createEnrollmentPlan(fixture(), {...settings, projectId: 'different-project'}), /project/);
  assert.throws(() => createEnrollmentPlan({...fixture(), projectId: 'demo-strawberry-flutter'},
    {...settings, projectId: 'demo-strawberry-flutter'}), /project/);
  assert.throws(() => createEnrollmentPlan(fixture(), {projectId}), /database/);
  assert.throws(() => createEnrollmentPlan({...fixture(), databaseId: 'other'}, {...settings, databaseId: 'other'}), /database/);
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
    'WORKER_EMULATOR_ONLY', 'FIREBASE_EMULATOR_HUB', 'FUNCTIONS_EMULATOR']) {
    assert.throws(() => createEnrollmentPlan(fixture(), {...settings, environment: {[key]: ''}}), /environment/);
  }
  assert.throws(() => createEnrollmentPlan(fixture(), {...settings, environment: {GCLOUD_PROJECT: 'other-project'}}), /environment/);
});

test('explicit output uses 0600 and refuses existing files, final and ancestor symlinks', async () => temporary(async root => {
  const plan = createEnrollmentPlan(fixture(), settings), output = join(root, 'review.json');
  await writeNewPlan(output, plan);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), plan);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(writeNewPlan(output, plan), {code: 'EEXIST'});
  const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'KEEP');
  const link = join(root, 'plan-link'); await symlink(sentinel, link);
  await assert.rejects(writeNewPlan(link, plan));
  assert.equal(await readFile(sentinel, 'utf8'), 'KEEP');
  await mkdir(join(root, 'real')); await symlink(join(root, 'real'), join(root, 'linked-parent'));
  await assert.rejects(writeNewPlan(join(root, 'linked-parent', 'new.json'), plan), /Symlink/);
  assert.deepEqual(await readdir(join(root, 'real')), []);
  await assert.rejects(writeNewPlan('relative.json', plan), /absolute/);
}));

test('bounded JSON input rejects oversized, invalid UTF-8 and symlink files', async () => temporary(async root => {
  const path = join(root, 'request.json'); await writeFile(path, JSON.stringify(fixture()));
  assert.deepEqual(await readEnrollmentRequest(path), fixture());
  await symlink(path, join(root, 'linked.json'));
  await assert.rejects(readEnrollmentRequest(join(root, 'linked.json')), /Symlink/);
  await writeFile(path, ' '.repeat(16385));
  await assert.rejects(readEnrollmentRequest(path), /large/);
  await writeFile(path, Buffer.from([0xff]));
  await assert.rejects(readEnrollmentRequest(path), /UTF-8 JSON/);
}));

test('default CLI succeeds with filesystem writes denied and network/process calls trapped', async () => temporary(async root => {
  const requestPath = join(root, 'request.json'), tripwire = join(root, 'tripwire.mjs');
  await writeFile(requestPath, JSON.stringify(fixture()));
  await writeFile(tripwire, `
import {syncBuiltinESMExports} from 'node:module';
import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
import tls from 'node:tls'; import dgram from 'node:dgram'; import dns from 'node:dns';
import childProcess from 'node:child_process';
const denied = () => {throw Error('NETWORK_OR_PROCESS_FORBIDDEN');};
for (const [module, names] of [[http,['request','get']], [https,['request','get']],
 [net,['connect','createConnection']], [tls,['connect']], [dgram,['createSocket']],
 [dns,['lookup','resolve']], [childProcess,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])
 for (const name of names) module[name] = denied;
net.Socket.prototype.connect = denied; globalThis.fetch = denied;
syncBuiltinESMExports();
`);
  const before = await readdir(root);
  // Ancestor lstat checks need directory read access; no fs-write grant exists.
  const result = cli(requestPath, [], ['--permission', '--allow-fs-read=*', '--import', tripwire]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'preparation-only');
  assert.equal(plan.authorizationGranted, false);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(requestPath, 'utf8'), JSON.stringify(fixture()));
}));

test('CLI has no apply option and validates before writing any plan output', async () => temporary(async root => {
  const requestPath = join(root, 'request.json'), output = join(root, 'should-not-exist.json');
  await writeFile(requestPath, JSON.stringify({...fixture(), ownerUid: 'invalid/uid'}));
  assert.notEqual(cli(requestPath, ['--out', output]).status, 0);
  assert.deepEqual(await readdir(root), ['request.json']);
  await writeFile(requestPath, JSON.stringify(fixture()));
  assert.notEqual(cli(requestPath, ['--apply', 'yes']).status, 0);
  const emulated = cli(requestPath, [], [], {...cleanEnvironment(), WORKER_EMULATOR_ONLY: 'true'});
  assert.notEqual(emulated.status, 0);
  assert.match(emulated.stderr, /environment rejected/);
  const result = cli(requestPath, ['--out', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).planHashSha256, JSON.parse(result.stdout).planHashSha256);
}));
