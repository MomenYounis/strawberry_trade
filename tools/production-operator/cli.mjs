#!/usr/bin/env node
import {createEnrollmentPlan, readEnrollmentRequest, writeNewPlan} from './plan.mjs';

const usage = 'Usage: node tools/production-operator/cli.mjs --project PROJECT_ID --database "(default)" --request REQUEST.json [--out /absolute/new-plan.json]';
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage + '\nPreparation only: no live checks, network, credentials, apply command or cloud writes.\n');
  } else {
    const options = Object.create(null), allowed = new Set(['project', 'database', 'request', 'out']);
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]?.slice(2), value = args[i + 1];
      if (!args[i]?.startsWith('--') || !allowed.has(name) || !value || value.startsWith('--') ||
          Object.hasOwn(options, name)) throw Error(usage);
      options[name] = value;
    }
    if (!options.project || !options.database || !options.request) throw Error(usage);
    const request = await readEnrollmentRequest(options.request);
    const plan = createEnrollmentPlan(request, {projectId: options.project, databaseId: options.database,
      environment: process.env});
    if (options.out) await writeNewPlan(options.out, plan);
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  }
} catch (error) {
  // Do not echo request contents, paths, credentials or native key errors.
  const message = error.code === 'EEXIST' ? 'Output already exists; choose a new file' :
    error.code ? 'Local file operation refused' : error.message;
  process.stderr.write('Onboarding plan error: ' + message + '\n');
  process.exitCode = 1;
}
