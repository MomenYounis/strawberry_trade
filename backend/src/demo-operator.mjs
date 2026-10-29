/** Local fixture/operator boundary. Never add a production override here. */
export const DEMO_PROJECT_ID = 'demo-strawberry-flutter';

function loopbackEndpoint(value) {
  if (typeof value !== 'string') return false;
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
  return match !== null && match[0] === value && Number(match[2]) <= 65535;
}

export function assertDemoOperatorEnvironment(projectId, env = process.env) {
  // Check both services before reading a UID, initializing Admin or revoking a
  // token. A Firestore-only emulator variable can otherwise leave Auth live.
  if (projectId !== DEMO_PROJECT_ID ||
      !loopbackEndpoint(env.FIRESTORE_EMULATOR_HOST) ||
      !loopbackEndpoint(env.FIREBASE_AUTH_EMULATOR_HOST) ||
      [env.GCLOUD_PROJECT, env.GOOGLE_CLOUD_PROJECT]
        .some(value => value !== undefined && value !== DEMO_PROJECT_ID)) {
    throw Error('Local demo operators require project demo-strawberry-flutter and both loopback Firestore/Auth emulators; production operations are disabled.');
  }
}

export async function runDemoOperator(projectId, operation, env = process.env) {
  assertDemoOperatorEnvironment(projectId, env);
  return operation();
}
