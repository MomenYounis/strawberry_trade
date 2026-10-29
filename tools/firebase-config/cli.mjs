#!/usr/bin/env node
import { resolve } from 'node:path';
import { androidPackage, productionDefinitions, readPublicJson, writeExternalDefinitions } from './config.mjs';

const usage = 'Usage: node tools/firebase-config/cli.mjs --google-services PATH --license-public-keys PATH --out EXTERNAL_PATH [--project EXPECTED_PROJECT_ID] [--gateway-url HTTPS_BASE_URL]';

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${usage}\n`);
  } else {
    const allowed = new Set(['google-services', 'license-public-keys', 'out', 'project', 'gateway-url']);
    const options = Object.create(null);
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]?.slice(2);
      if (!args[i]?.startsWith('--') || !allowed.has(name) || !args[i + 1] ||
          args[i + 1].startsWith('--') || Object.hasOwn(options, name)) throw new Error(usage);
      options[name] = args[i + 1];
    }
    for (const required of ['google-services', 'license-public-keys', 'out']) {
      if (!options[required]) throw new Error(`Missing --${required}. ${usage}`);
    }
    const definitions = productionDefinitions(
      readPublicJson(resolve(options['google-services']), 'google-services'),
      readPublicJson(resolve(options['license-public-keys']), 'license public keys'),
      { expectedProject: options.project, gatewayUrl: options['gateway-url'] ?? '' },
    );
    const path = writeExternalDefinitions(resolve(options.out), definitions);
    process.stdout.write(`Validated Android package ${androidPackage} and Firebase project ${definitions.FIREBASE_PROJECT_ID}.\n`);
    process.stdout.write(`Created production Dart definitions: ${path}\n`);
    process.stdout.write('This verifies local configuration only; signing, live App Check, deployment and trusted onboarding require their own verification.\n');
  }
} catch (error) {
  const message = error.code === 'EEXIST'
    ? 'Output already exists; keep the reviewed file or choose a new output path'
    : error.message;
  process.stderr.write(`Firebase configuration error: ${message}\n`);
  process.exitCode = 1;
}
