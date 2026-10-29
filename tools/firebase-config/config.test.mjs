import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { androidPackage, canonicalGatewayUrl, licensePublicKeys, productionDefinitions, readPublicJson, writeExternalDefinitions } from './config.mjs';

// Public test vector from RFC 8032, section 7.1. No private key is needed here.
const raw = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
const spki = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
  .export({ type: 'spki', format: 'pem' }).toString();
const keyMap = { 'approved-2026': raw };
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const project = resolve(dirname(cli), '../..');
function downloaded() {
  return {
    project_info: { project_id: 'strawberry-approved-project', project_number: '123456789012' },
    client: [{
      client_info: {
        mobilesdk_app_id: '1:123456789012:android:0123456789abcdef',
        android_client_info: { package_name: androidPackage },
      },
      api_key: [{ current_key: `AIza${'a'.repeat(35)}` }],
    }],
  };
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strawberry-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('matching Android download creates production definitions without changing its input', () => {
  const input = downloaded();
  const before = JSON.stringify(input);
  const result = productionDefinitions(input, keyMap, { expectedProject: input.project_info.project_id });
  assert.equal(result.USE_EMULATORS, 'false');
  assert.equal(result.FIREBASE_PROJECT_ID, input.project_info.project_id);
  assert.equal(result.FIREBASE_ANDROID_APP_ID, input.client[0].client_info.mobilesdk_app_id);
  assert.equal(result.FIREBASE_SENDER_ID, input.project_info.project_number);
  assert.equal(result.FIREBASE_API_KEY, input.client[0].api_key[0].current_key);
  assert.deepEqual(JSON.parse(result.LICENSE_PUBLIC_KEYS), keyMap);
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.values(result).every(value => typeof value === 'string'));
});

test('package matching selects its client and refuses wrong or ambiguous Android registrations', () => {
  const wrong = downloaded();
  wrong.client[0].client_info.android_client_info.package_name = 'com.other.application';
  assert.throws(() => productionDefinitions(wrong, keyMap), /exactly one Android client/);
  const correct = downloaded();
  correct.client.unshift(wrong.client[0]);
  assert.equal(productionDefinitions(correct, keyMap).FIREBASE_ANDROID_APP_ID, correct.client[1].client_info.mobilesdk_app_id);
  correct.client.push(correct.client[1]);
  assert.throws(() => productionDefinitions(correct, keyMap), /exactly one Android client/);
});

test('sender mismatch and a web app ID cannot become Android production configuration', () => {
  for (const appId of ['1:555555555555:android:0123456789abcdef', '1:123456789012:web:0123456789abcdef', '', null]) {
    const input = downloaded();
    input.client[0].client_info.mobilesdk_app_id = appId;
    assert.throws(() => productionDefinitions(input, keyMap), /app ID must match/);
  }
  const missing = downloaded();
  delete missing.project_info.project_number;
  assert.throws(() => productionDefinitions(missing, keyMap), /project number/);
});

test('production mode refuses demo projects, wrong expected project and missing API keys', () => {
  const input = downloaded();
  assert.throws(() => productionDefinitions(input, keyMap, { expectedProject: 'another-project' }), /does not match/);
  input.project_info.project_id = 'demo-strawberry-flutter';
  assert.throws(() => productionDefinitions(input, keyMap), /non-demo/);
  input.project_info.project_id = 'strawberry-approved-project';
  input.client[0].api_key = [];
  assert.throws(() => productionDefinitions(input, keyMap), /API key/);
});

test('trust map must be nonempty with canonical 32-byte public keys and valid IDs', () => {
  for (const input of [null, [], {}, { kid: '' }, { kid: Buffer.alloc(31).toString('base64url') },
    { kid: `${raw}=` }, { kid: raw.slice(0, -1) + 'r' }, { 'invalid key id': raw },
    { kid: spki }, { kid: 42 }]) {
    assert.throws(() => licensePublicKeys(input));
  }
  const rotation = licensePublicKeys({ 'second-issuer': raw, 'first-issuer': raw });
  assert.deepEqual(Object.keys(rotation), ['first-issuer', 'second-issuer']);
});

test('issuer keygen public output is accepted only if SPKI and raw Ed25519 keys agree', () => {
  const input = { kid: 'approved-2026', publicKey: raw, spkiPem: spki };
  assert.deepEqual({ ...licensePublicKeys(input) }, keyMap);
  assert.deepEqual({ ...licensePublicKeys({ kid: 'approved-2026', publicKey: raw }) }, keyMap);
  assert.throws(() => licensePublicKeys({ ...input, publicKey: Buffer.alloc(32, 1).toString('base64url') }), /SPKI/);
  assert.throws(() => licensePublicKeys({ ...input, spkiPem: 'not a public PEM' }), /SPKI/);
  assert.throws(() => licensePublicKeys({ ...input, privateKey: 'never include private material' }), /unsupported fields/);
});

test('existing output and output symlinks are refused without changing their targets', t => {
  const dir = temporary(t);
  const file = join(dir, 'reviewed.json');
  writeFileSync(file, 'reviewed original\n');
  const definitions = productionDefinitions(downloaded(), keyMap);
  assert.throws(() => writeExternalDefinitions(file, definitions), { code: 'EEXIST' });
  assert.equal(readFileSync(file, 'utf8'), 'reviewed original\n');
  const link = join(dir, 'alias.json');
  symlinkSync(file, link);
  assert.throws(() => writeExternalDefinitions(link, definitions), { code: 'EEXIST' });
  assert.equal(readFileSync(file, 'utf8'), 'reviewed original\n');
});

test('output stays outside source even when an external parent symlink redirects inside', t => {
  const dir = temporary(t);
  const definitions = productionDefinitions(downloaded(), keyMap);
  assert.throws(() => writeExternalDefinitions(join(project, 'production-defines.json'), definitions), /outside/);
  const link = join(dir, 'source-link');
  symlinkSync(project, link, 'dir');
  assert.throws(() => writeExternalDefinitions(join(link, 'production-defines.json'), definitions), /outside/);
});

test('CLI creates consumable external JSON, prints no API key, and refuses a second write', t => {
  const dir = temporary(t);
  const google = join(dir, 'google-services.json');
  const publicFile = join(dir, 'issuer-public.json');
  const output = join(dir, 'production', 'defines.json');
  writeFileSync(google, JSON.stringify(downloaded()));
  writeFileSync(publicFile, JSON.stringify({ kid: 'approved-2026', publicKey: raw, spkiPem: spki }));
  const args = [cli, '--google-services', google, '--license-public-keys', publicFile,
    '--out', output, '--project', 'strawberry-approved-project'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const bytes = readFileSync(output, 'utf8');
  assert.deepEqual(JSON.parse(bytes), productionDefinitions(downloaded(), keyMap));
  assert.ok(!first.stdout.includes(downloaded().client[0].api_key[0].current_key));
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(output, 'utf8'), bytes);
});

test('malformed JSON diagnostics do not echo file contents and unknown CLI flags fail', t => {
  const dir = temporary(t);
  const malformed = join(dir, 'bad.json');
  writeFileSync(malformed, '{not-json-accidental-sensitive-content');
  assert.throws(() => readPublicJson(malformed, 'public input'), { message: 'Invalid JSON in public input file' });
  const result = spawnSync(process.execPath, [cli, '--unknown', 'value'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
});

test('public HTTPS gateway bases use the shared Dart/client canonical cases', () => {
  const cases = readPublicJson(new URL('./endpoint-cases.json', import.meta.url), 'endpoint cases');
  for (const { input, expected } of cases.valid) assert.equal(canonicalGatewayUrl(input), expected);
});

test('gateway configuration rejects insecure, local, credential-bearing and ambiguous URLs', () => {
  const cases = readPublicJson(new URL('./endpoint-cases.json', import.meta.url), 'endpoint cases');
  for (const input of cases.invalid) assert.throws(() => canonicalGatewayUrl(input), /Gateway URL/, input);
  assert.throws(() => canonicalGatewayUrl(`https://gateway.example.com/${'a'.repeat(2048)}`), /Gateway URL/);
});

test('external routing is opt-in and never alters existing Functions definitions by default', () => {
  assert.ok(!Object.hasOwn(productionDefinitions(downloaded(), keyMap), 'GATEWAY_BASE_URL'));
  const result = productionDefinitions(downloaded(), keyMap, { gatewayUrl: 'https://Gateway.Example.COM/api/' });
  assert.equal(result.GATEWAY_BASE_URL, 'https://gateway.example.com/api');
  assert.equal(result.USE_EMULATORS, 'false');
  assert.throws(() => productionDefinitions(downloaded(), keyMap, { gatewayUrl: 'http://localhost:8008' }), /Gateway URL/);
});

test('CLI accepts optional gateway URL and rejects unsafe overrides before writing', t => {
  const dir = temporary(t);
  const google = join(dir, 'google-services.json');
  const publicFile = join(dir, 'issuer-public.json');
  const output = join(dir, 'defines.json');
  writeFileSync(google, JSON.stringify(downloaded()));
  writeFileSync(publicFile, JSON.stringify(keyMap));
  const common = [cli, '--google-services', google, '--license-public-keys', publicFile, '--out', output];
  const invalid = spawnSync(process.execPath, [...common, '--gateway-url', 'https://user:password@gateway.example.com'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Gateway URL/);
  assert.ok(!invalid.stderr.includes('password'));
  const valid = spawnSync(process.execPath, [...common, '--gateway-url', 'https://Gateway.Example.COM/api/'], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).GATEWAY_BASE_URL, 'https://gateway.example.com/api');
});
