import {OAuth2Client} from 'google-auth-library';
import {assertDemoOperatorEnvironment} from '../src/demo-operator.mjs';

/**
 * REST gax authenticates after Firestore adds its emulator owner header. A
 * service-account JWT otherwise replaces that header and is correctly denied
 * by the emulator's client rules. This credential is valid ONLY on the two
 * explicitly validated loopback demo services; it has no production meaning.
 */
export function emulatorFirestoreSettings(projectId,environment) {
  assertDemoOperatorEnvironment(projectId,environment);
  const authClient=new OAuth2Client();
  authClient.setCredentials({access_token:'owner'});
  return {authClient};
}
