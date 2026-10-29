import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const androidPackage = 'com.strawberrytrade.strawberry_trade';
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

export function readPublicJson(path, description) {
  const data = readFileSync(path);
  if (data.length > 200000) fail(`${description} file is too large`);
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    fail(`Invalid JSON in ${description} file`);
  }
}

function rawEd25519(value) {
  // Buffer's base64 decoder is permissive, so check alphabet and canonical form.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    fail('License public keys must be raw 32-byte Ed25519 keys in unpadded base64url');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    fail('License public keys must be raw 32-byte Ed25519 keys in canonical base64url');
  }
  return value;
}

export function licensePublicKeys(input) {
  if (!object(input)) fail('License public keys must be a public key map or issuer public JSON');
  let keys = input;
  if (Object.hasOwn(input, 'kid') && Object.hasOwn(input, 'publicKey')) {
    if (Object.keys(input).some(key => !['kid', 'publicKey', 'spkiPem'].includes(key))) {
      fail('Issuer public JSON contains unsupported fields; never supply private key material');
    }
    if (typeof input.kid !== 'string') fail('Invalid license public key ID');
    const raw = rawEd25519(input.publicKey);
    if (Object.hasOwn(input, 'spkiPem')) {
      try {
        if (typeof input.spkiPem !== 'string' ||
            !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(input.spkiPem)) throw new Error();
        const key = createPublicKey(input.spkiPem);
        if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'jwk' }).x !== raw) {
          throw new Error();
        }
      } catch {
        fail('Issuer SPKI must be an Ed25519 public key matching the raw public key');
      }
    }
    keys = { [input.kid]: raw };
  }
  const entries = Object.entries(keys);
  if (entries.length < 1 || entries.length > 100) fail('Provide a nonempty approved license public-key map (maximum 100 keys)');
  const result = Object.create(null);
  for (const [kid, raw] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(kid)) fail('Invalid license public key ID');
    result[kid] = rawEd25519(raw);
  }
  return result;
}

export function canonicalGatewayUrl(input) {
  if (input === '') return '';
  const invalid = () => fail('Gateway URL must be an unambiguous HTTPS public-host base URL without credentials, query or fragment');
  if (typeof input !== 'string' || input.length > 2048 || /[^\x21-\x7e]|\\/.test(input)) invalid();
  const parts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(input);
  if (!parts || parts[1].toLowerCase() !== 'https') invalid();
  const authority = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(parts[2]);
  if (!authority) invalid();
  const host = authority[1].toLowerCase();
  const port = authority[2] === undefined ? undefined : Number(authority[2]);
  if (port !== undefined && (port < 1 || port > 65535)) invalid();
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels.at(-1)) ||
      ['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid', 'example'].includes(labels.at(-1))) invalid();
  const path = parts[3] ?? '';
  const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
  if (normalizedPath && normalizedPath.slice(1).split('/').some(
    segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment),
  )) invalid();
  return `https://${host}${port === undefined || port === 443 ? '' : `:${port}`}${normalizedPath}`;
}

export function productionDefinitions(googleServices, publicKeys, { expectedProject, gatewayUrl = '' } = {}) {
  if (!object(googleServices) || !object(googleServices.project_info) || !Array.isArray(googleServices.client)) {
    fail('Invalid Android google-services configuration');
  }
  const { project_id: projectId, project_number: senderId } = googleServices.project_info;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')) {
    fail('Production requires a valid non-demo Firebase project ID');
  }
  if (expectedProject !== undefined && projectId !== expectedProject) fail('Downloaded Firebase project does not match --project');
  if (typeof senderId !== 'string' || !/^[1-9][0-9]{5,19}$/.test(senderId)) fail('Missing or invalid Firebase project number / sender ID');
  const clients = googleServices.client.filter(client => client?.client_info?.android_client_info?.package_name === androidPackage);
  if (clients.length !== 1) fail(`Expected exactly one Android client for ${androidPackage}`);
  const client = clients[0];
  const appId = client.client_info.mobilesdk_app_id;
  const appIdMatch = typeof appId === 'string' ? /^1:([1-9][0-9]*):android:([a-f0-9]+)$/.exec(appId) : null;
  if (!appIdMatch || appIdMatch[1] !== senderId) fail('Android Firebase app ID must match the project number / sender ID');
  if (!Array.isArray(client.api_key) || client.api_key.length !== 1 ||
      typeof client.api_key[0]?.current_key !== 'string' ||
      !/^AIza[A-Za-z0-9_-]{35}$/.test(client.api_key[0].current_key)) {
    fail('Expected exactly one valid Firebase client API key');
  }
  const trustedKeys = licensePublicKeys(publicKeys);
  const endpoint = canonicalGatewayUrl(gatewayUrl);
  return {
    USE_EMULATORS: 'false',
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_ANDROID_APP_ID: appId,
    FIREBASE_API_KEY: client.api_key[0].current_key,
    FIREBASE_SENDER_ID: senderId,
    LICENSE_PUBLIC_KEYS: JSON.stringify(trustedKeys),
    ...(endpoint === '' ? {} : { GATEWAY_BASE_URL: endpoint }),
  };
}

function resolvedOutput(path) {
  let existing = resolve(path);
  const remaining = [];
  while (!existsSync(existing)) {
    remaining.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) fail('Cannot resolve output directory');
    existing = parent;
  }
  return resolve(realpathSync(existing), ...remaining);
}

export function writeExternalDefinitions(path, definitions) {
  const actual = resolvedOutput(path);
  const rel = relative(realpathSync(projectDirectory), actual);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    fail('Keep production definitions outside the application source directory');
  }
  mkdirSync(dirname(actual), { recursive: true, mode: 0o700 });
  // Exclusive creation also refuses an existing symlink. An old reviewed build
  // configuration is never replaced silently by a different Android registration.
  writeFileSync(actual, `${JSON.stringify(definitions, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return actual;
}
