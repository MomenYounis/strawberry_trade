/** Trusted operator tooling only. Never import this directory into the Flutter APK. */
import { createPublicKey, sign, verify } from 'node:crypto';

export const TRIAL_MS = 30 * 24 * 60 * 60 * 1000;
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error('Only JSON safe integers are allowed');
}
export function rawPublicKey(publicKey) {
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new Error('Expected Ed25519 issuer key');
  return jwk.x;
}
export function signPayload(payload, privateKey, kid) {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 issuer key');
  if (typeof kid !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(kid)) throw new Error('Invalid key id');
  return { kid, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
}
function decode64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid base64url');
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s) throw new Error('Noncanonical base64url');
  return b;
}
export function verifyEnvelope(envelope, publicKey, expectedKid) {
  keys(envelope, ['kid', 'payload', 'signature']);
  if (envelope.kid !== expectedKid) throw new Error('Untrusted key id');
  const payload = decode64(envelope.payload), signature = decode64(envelope.signature);
  if (payload.length > 50000 || signature.length !== 64 || !verify(null, payload, publicKey, signature)) throw new Error('Invalid signature');
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  if (canonicalJson(result) !== payload.toString('utf8')) throw new Error('Noncanonical payload');
  return result;
}
function keys(object, expected) {
  if (!object || Array.isArray(object) || typeof object !== 'object' ||
    Object.keys(object).length !== expected.length || !Object.keys(object).every(k => expected.includes(k))) throw new Error('Unexpected fields');
}
function text(o, k, max = 128) {
  if (typeof o[k] !== 'string' || !o[k].length || o[k].length > max || /[\x00-\x1f]/.test(o[k])) throw new Error(`Invalid ${k}`);
}
function number(o, k, min = 0, max = 253402300799999) {
  if (!Number.isSafeInteger(o[k]) || o[k] < min || o[k] > max) throw new Error(`Invalid ${k}`);
}
export function validatePayloads(entitlement, membership) {
  keys(entitlement, ['type','version','tenantId','licenseId','epoch','issuedAtMs','notBeforeMs','expiresAtMs','trialStartMs','trial','maxDevices']);
  keys(membership, ['type','version','tenantId','uid','deviceId','role','epoch','entitlementEpoch','issuedAtMs','expiresAtMs','enabled']);
  if (entitlement.type !== 'entitlement' || membership.type !== 'membership' || entitlement.version !== 1 || membership.version !== 1) throw new Error('Invalid version/type');
  for (const key of ['tenantId','licenseId']) text(entitlement, key);
  for (const key of ['tenantId','uid','deviceId']) text(membership, key);
  for (const key of ['issuedAtMs','notBeforeMs']) number(entitlement, key);
  number(entitlement,'epoch',1,Number.MAX_SAFE_INTEGER); number(entitlement,'maxDevices',1,1000);
  number(membership,'epoch',1,Number.MAX_SAFE_INTEGER); number(membership,'entitlementEpoch',1,Number.MAX_SAFE_INTEGER); number(membership,'issuedAtMs');
  if (typeof entitlement.trial !== 'boolean' || typeof membership.enabled !== 'boolean' || !['manager','employee'].includes(membership.role)) throw new Error('Invalid policy');
  if (entitlement.expiresAtMs !== null) number(entitlement,'expiresAtMs');
  if (membership.expiresAtMs !== null) number(membership,'expiresAtMs');
  if (entitlement.trialStartMs !== null) number(entitlement,'trialStartMs');
  if (entitlement.issuedAtMs < entitlement.notBeforeMs ||
      (entitlement.expiresAtMs !== null && entitlement.expiresAtMs <= entitlement.notBeforeMs)) throw new Error('Invalid validity');
  if (entitlement.trial && (entitlement.trialStartMs === null || entitlement.notBeforeMs !== entitlement.trialStartMs || entitlement.expiresAtMs !== entitlement.trialStartMs + TRIAL_MS)) throw new Error('Trial must be exactly 30 × 24h');
  if (!entitlement.trial && entitlement.trialStartMs !== null) throw new Error('Paid entitlement must not create a trial');
  if (entitlement.tenantId !== membership.tenantId || entitlement.epoch !== membership.entitlementEpoch) throw new Error('Mismatched tenant/entitlement');
  canonicalJson(entitlement); canonicalJson(membership);
}
export function signPackage(entitlement, membership, privateKey, kid) {
  validatePayloads(entitlement, membership);
  return { version: 1, entitlement: signPayload(entitlement, privateKey, kid), membership: signPayload(membership, privateKey, kid) };
}
export function verifyPackage(input, publicKey, kid) {
  keys(input, ['version','entitlement','membership']);
  if (input.version !== 1) throw new Error('Invalid package version');
  const entitlement = verifyEnvelope(input.entitlement, publicKey, kid);
  const membership = verifyEnvelope(input.membership, publicKey, kid);
  validatePayloads(entitlement, membership);
  return { entitlement, membership };
}
