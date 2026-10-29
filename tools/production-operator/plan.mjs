import {createHash, createPublicKey} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, resolve} from 'node:path';

const requestFields = ['projectId', 'databaseId', 'ownerUid', 'expectedEmail',
  'tenantId', 'managerName', 'deviceId', 'publicKeySpki', 'maxDevices'];
const emulatorVariables = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST',
  'WORKER_EMULATOR_ONLY', 'FIREBASE_EMULATOR_HUB', 'FUNCTIONS_EMULATOR'];
const maxRequestBytes = 16384;
const trialDurationMs = 30 * 24 * 60 * 60 * 1000;
const fail = message => {throw new Error(message);};
const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) fail('Invalid ' + label);
}

/** Pure preparation: no Admin SDK, credentials, network, clock or cloud writes. */
export function createEnrollmentPlan(request, {projectId, databaseId, environment = {}} = {}) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).length !== requestFields.length ||
      !Object.keys(request).every(key => requestFields.includes(key))) fail('Unexpected request fields');
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
      projectId.startsWith('demo-') || request.projectId !== projectId) fail('Explicit production project must match request');
  // The reviewed gateway currently selects default Firestore, not a named DB.
  if (databaseId !== '(default)' || request.databaseId !== databaseId) fail('Explicit default database must match request');
  if (emulatorVariables.some(key => environment[key] !== undefined) ||
      ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'].some(key =>
        environment[key] !== undefined && environment[key] !== projectId)) fail('Emulator or conflicting project environment rejected');
  identifier(request.ownerUid, 'owner UID');
  identifier(request.tenantId, 'tenant ID');
  if (typeof request.expectedEmail !== 'string' || request.expectedEmail.length > 254 ||
      !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(request.expectedEmail)) fail('Invalid expected email');
  if (typeof request.managerName !== 'string' || request.managerName !== request.managerName.trim() ||
      !request.managerName || request.managerName.length > 120 || /[\x00-\x1f\x7f]/.test(request.managerName)) fail('Invalid manager name');
  if (!Number.isSafeInteger(request.maxDevices) || request.maxDevices < 1 || request.maxDevices > 1000) fail('Invalid maxDevices');
  let publicKeyBytes;
  try {
    if (typeof request.publicKeySpki !== 'string' || request.publicKeySpki.length > 500 ||
        !/^[A-Za-z0-9_-]+$/.test(request.publicKeySpki)) throw Error();
    publicKeyBytes = Buffer.from(request.publicKeySpki, 'base64url');
    if (publicKeyBytes.toString('base64url') !== request.publicKeySpki) throw Error();
    const key = createPublicKey({key: publicKeyBytes, format: 'der', type: 'spki'});
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        !key.export({format: 'der', type: 'spki'}).equals(publicKeyBytes) ||
        createHash('sha256').update(publicKeyBytes).digest('base64url') !== request.deviceId) throw Error();
  } catch {fail('Device requires canonical P-256 SPKI and matching SHA-256 device ID');}

  const target = structuredClone(request), root = 'tenants/' + target.tenantId;
  const clock = {source: 'trusted-application-server-clock', captureAt: 'approved-application',
    trialStartMs: 'SERVER_TIME_MS', trialEndMs: 'SERVER_TIME_MS + ' + trialDurationMs,
    durationMs: trialDurationMs};
  const plan = {
    schemaVersion: 1, kind: 'strawberry-owner-enrollment-plan', mode: 'preparation-only',
    executable: false, authorizationGranted: false, liveChecksPerformed: false,
    target, publicKeySha256Hex: digest(publicKeyBytes),
    requiredChecksBeforeApplication: [
      {check: 'manual-owner-and-key-handoff', status: 'not-performed',
        requirement: 'Trusted operator must verify the owner identity and that this exact UID, email and public key request came from the intended physical phone.'},
      {check: 'existing-verified-active-account', status: 'not-performed',
        requirement: 'Read this exact existing UID in the explicit project; require its email to equal expectedEmail, emailVerified=true and disabled=false. Do not create an account, reset credentials or infer a UID from email.'},
      {check: 'tenant-and-history-absent', status: 'not-performed',
        requirement: 'Refuse an existing tenant or any prior trial/enrollment for this business. Recover or transfer the original identity instead; deletion, another tenant ID or retry must never restart its trial.'},
      {check: 'fresh-target-and-absence-checks', status: 'not-performed',
        requirement: 'Recheck project, default database, owner identity, device key and all create-only document preconditions immediately before an approved application.'},
      {check: 'deployment-and-index-review', status: 'not-performed',
        requirement: 'Verify the approved live gateway, physical-device App Check, protected tenant rules and existing Admin endpoints; verify the employeeChanges(uid ASC, sequence ASC) COLLECTION composite index is READY. No rules or indexes are deployed by this tool.'},
    ],
    proposedActions: [
      {operation: 'revoke-owner-refresh-tokens', uid: target.ownerUid, order: 'before-firestore-transaction',
        effect: 'Revokes existing connected sessions for this UID across the Firebase project, including the old website. Owner must sign in again.',
        atomicity: 'Auth revocation is separate from Firestore. It can succeed even when the subsequent transaction fails. An approved implementation needs explicit partial-failure and retry handling.'},
      {operation: 'firestore-create-only-transaction', clock,
        documents: [
          {path: root, precondition: 'must-not-exist', data: {ownerUid: target.ownerUid, enabled: true,
            trialStartMs: 'SERVER_TIME_MS', trialEndMs: 'SERVER_TIME_MS + ' + trialDurationMs,
            entitlementEpoch: 1, licenseId: 'trial_' + target.tenantId, maxDevices: target.maxDevices,
            managerDeviceCount: 1, deviceCount: 1, sequence: 0}},
          {path: root + '/members/' + target.ownerUid, precondition: 'must-not-exist',
            data: {uid: target.ownerUid, role: 'manager', name: target.managerName, active: true, epoch: 1}},
          {path: root + '/devices/' + target.deviceId, precondition: 'must-not-exist',
            data: {id: target.deviceId, deviceId: target.deviceId, tenantId: target.tenantId,
              uid: target.ownerUid, publicKeySpki: target.publicKeySpki, active: true,
              role: 'manager', enrolledAtMs: 'SERVER_TIME_MS'}},
          {path: root + '/audit/tenant_created', precondition: 'must-not-exist',
            data: {action: 'tenant-created', actorUid: 'trusted-operator', ownerUid: target.ownerUid, atMs: 'SERVER_TIME_MS'}},
        ]},
    ],
    privateKeyProof: {performed: false, stage: 'subsequent-protected-bootstrap',
      requirement: 'No session or signed membership is issued by this plan. After trusted registration, the existing bootstrap endpoint requires the enrolled private key to sign its fresh P-256 challenge before issuing a session and package.'},
    boundaries: ['No account, credential, permission, secret, deployment, Firestore rule or production record was created or changed.',
      'No live account, ownership, prior trial, deployment, index or device proof was verified.',
      'This plan and its hash are review artifacts, not approval or an executable authorization.',
      'Real onboarding/application is not implemented by this tool. A concrete reviewed action requires separate owner approval.'],
  };
  return {...plan, planHashSha256: digest(canonical(plan))};
}

async function assertNoSymlinks(path) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail('Symlink paths are not allowed');
  }
  return absolute;
}

export async function readEnrollmentRequest(path) {
  const absolute = await assertNoSymlinks(path);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) fail('Request must be a regular JSON file');
    const bytes = Buffer.alloc(maxRequestBytes + 1);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxRequestBytes) fail('Request is too large');
    try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, bytesRead)));}
    catch {fail('Request must be valid UTF-8 JSON');}
  } finally {await handle.close();}
}

export async function writeNewPlan(path, plan) {
  if (!isAbsolute(path)) fail('Output path must be absolute');
  const absolute = resolve(path);
  await assertNoSymlinks(dirname(absolute));
  // Exclusive creation also rejects an existing final-component symlink.
  const handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {await handle.writeFile(JSON.stringify(plan, null, 2) + '\n', 'utf8');}
  finally {await handle.close();}
  return absolute;
}
