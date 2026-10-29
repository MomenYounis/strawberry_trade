import {GatewayError} from './validation.mjs';
import {assertDemoOperatorEnvironment} from './demo-operator.mjs';

export const HTTP_METHODS = Object.freeze([
  'bootstrap', 'syncOperation', 'pullChanges', 'activateLicense',
  'setMemberActive', 'acceptInvitation', 'createEmployeeInvitation',
]);
const statuses = {
  UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400, RESOURCE_EXHAUSTED: 429, INTERNAL: 500,
  NOT_FOUND: 404, UNAVAILABLE: 503,
};
const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};
function response(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers});
}
function error(status, reason) {
  return response({error: {status, message: reason, details: {reason}}}, statuses[status]);
}

// The native callable SDK tags Java Longs. Decode only official integer tags,
// retaining the accounting contract's safe-integer boundary and bounded depth.
export function decodeCallable(value, depth = 0) {
  if (depth > 40) throw new GatewayError('invalid-argument');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new GatewayError('invalid-argument');
  if (Array.isArray(value)) return value.map(v => decodeCallable(v, depth + 1));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '@type')) {
      if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'value') ||
          !['type.googleapis.com/google.protobuf.Int64Value',
            'type.googleapis.com/google.protobuf.UInt64Value'].includes(value['@type']) ||
          typeof value.value !== 'string' || !/^-?(0|[1-9][0-9]{0,19})$/.test(value.value)) {
        throw new GatewayError('invalid-argument');
      }
      const integer = BigInt(value.value);
      if ((value['@type'].endsWith('UInt64Value') && integer < 0n) ||
          integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new GatewayError('invalid-argument');
      }
      return Number(integer);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeCallable(v, depth + 1)]));
  }
  return value;
}

async function bodyWithinLimit(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new GatewayError('invalid-argument');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayError('request-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {throw new GatewayError('invalid-argument');}
}

/** Callable-compatible transport for an approved external server, not a client SDK. */
export function createHttpGateway({
  gateway, auth, appCheck, expectedAppId, projectId, emulator = false,
  emulatorEnvironment = {}, maxBodyBytes = 65536, logFailure = () => {},
}) {
  if (emulator) assertDemoOperatorEnvironment(projectId, emulatorEnvironment);
  else if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') ||
      projectId.startsWith('demo-') || !/^1:[0-9]+:android:[a-f0-9]+$/.test(expectedAppId || '') ||
      typeof appCheck?.verifyToken !== 'function') {
    throw Error('A production project and its registered Android App Check verifier are required');
  }
  if (typeof auth?.verifyIdToken !== 'function' ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 65536 ||
      !HTTP_METHODS.every(method => typeof gateway?.[method] === 'function')) {
    throw Error('Incomplete trusted HTTP gateway configuration');
  }
  return async request => {
    try {
      const url = new URL(request.url);
      if (!emulator && url.protocol !== 'https:') return error('FAILED_PRECONDITION', 'https-required');
      if (url.pathname === '/health' && request.method === 'GET' && !url.search) {
        return response({status: 'ok', protocol: 'strawberry-gateway-v1'});
      }
      const method = url.pathname.slice(1);
      if (!HTTP_METHODS.includes(method) || url.search) return error('NOT_FOUND', 'endpoint-not-found');
      if (request.method !== 'POST') return error('INVALID_ARGUMENT', 'post-required');
      if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get('content-type') || '') ||
          !['', 'identity'].includes(request.headers.get('content-encoding') || '')) {
        return error('INVALID_ARGUMENT', 'json-required');
      }
      const length = request.headers.get('content-length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBodyBytes)) {
        return error('INVALID_ARGUMENT', 'request-too-large');
      }
      const bearer = /^Bearer ([A-Za-z0-9_.-]{1,16384})$/.exec(request.headers.get('authorization') || '');
      if (!bearer) return error('UNAUTHENTICATED', 'authentication-required');
      let attestation;
      if (!emulator) {
        const token = request.headers.get('x-firebase-appcheck');
        if (!token || token.length > 16384) return error('UNAUTHENTICATED', 'app-check-required');
        try {attestation = await appCheck.verifyToken(token);} catch {
          return error('UNAUTHENTICATED', 'app-check-invalid');
        }
        if (attestation.appId !== expectedAppId) return error('PERMISSION_DENIED', 'app-check-app-mismatch');
      }
      let decoded;
      try {decoded = await auth.verifyIdToken(bearer[1], true);} catch {
        return error('UNAUTHENTICATED', 'authentication-invalid');
      }
      if (typeof decoded.uid !== 'string' || !decoded.uid) return error('UNAUTHENTICATED', 'authentication-invalid');
      const body = await bodyWithinLimit(request, maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, 'data') ||
          !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
        return error('INVALID_ARGUMENT', 'invalid-argument');
      }
      const result = await gateway[method]({
        data: decodeCallable(body.data), auth: {uid: decoded.uid, token: decoded},
        ...(attestation ? {app: {appId: attestation.appId, token: attestation.token}} : {}),
      });
      return response({result});
    } catch (failure) {
      if (failure instanceof GatewayError) {
        const reason = /^[a-z][a-z0-9-]{0,79}$/.test(failure.code) ? failure.code : 'server-error';
        const status = {
          unauthenticated: 'UNAUTHENTICATED', 'permission-denied': 'PERMISSION_DENIED',
          'invalid-argument': 'INVALID_ARGUMENT', 'resource-exhausted': 'RESOURCE_EXHAUSTED',
          'request-too-large': 'INVALID_ARGUMENT',
        }[reason] || 'FAILED_PRECONDITION';
        return error(status, reason);
      }
      // Free-plan exhaustion is a retryable transport refusal, not a financial
      // conflict. Preserve provider details privately and the client outbox ID.
      if (failure?.code === 8) return error('RESOURCE_EXHAUSTED', 'backend-quota-exhausted');
      if (failure?.code === 14 || failure?.code === 4) return error('UNAVAILABLE', 'backend-unavailable');
      logFailure({errorType: failure instanceof Error ? failure.name : 'UnknownError'});
      return error('INTERNAL', 'server-error');
    }
  };
}
