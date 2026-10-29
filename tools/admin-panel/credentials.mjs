import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const PROJECT_ID = 'strawberry-trade-261017-6a49b';
export const DATABASE_ID = '(default)';
export const OPERATOR_EMAIL = 'momenfarghaly4@gmail.com';
const ANDROID_APP_ID = '1:713439663809:android:c0565e7ada543b0e2b6640';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FORBIDDEN_ENVIRONMENT = /^(?:FIREBASE_(?:TOKEN|CONFIG|CLIENT_ID|CLIENT_SECRET|.*_URL|.*EMULATOR.*|DEBUG.*)|FIRESTORE_(?:URL|.*EMULATOR.*)|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|GOOGLE_CLOUD_QUOTA_PROJECT|GOOGLE_CLOUD_UNIVERSE_DOMAIN|GOOGLE_API_USE_.*|NODE_OPTIONS|NODE_DEBUG|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|GOOGLE_SDK_NODE_LOGGING)$/;

export class ProductionCredentialsError extends Error {
  constructor(code) { super(code); this.name = 'ProductionCredentialsError'; this.code = code; }
}
const fail = code => { throw new ProductionCredentialsError(code); };

// Refuse credentials, emulators, endpoint overrides and debug interception from
// the launch environment. This panel always addresses one explicit project.
export function assertProductionEnvironment(environment = process.env) {
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value !== '' && FORBIDDEN_ENVIRONMENT.test(key)) fail('unsafe-operator-environment');
  }
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (environment[key] && environment[key] !== PROJECT_ID) fail('operator-project-mismatch');
  }
}

function loadProductionDependencies() {
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  return {
    getAccount: require('firebase-tools/lib/auth.js').getGlobalDefaultAccount,
    firebaseApi: require('firebase-tools/lib/api.js'),
    ...require('google-auth-library'),
    ...require('firebase-admin/app'),
    ...require('firebase-admin/auth'),
    Firestore: require('@google-cloud/firestore').Firestore,
    fetch: globalThis.fetch,
    readPublicConfiguration: async () => JSON.parse(await readFile(join(homedir(), '.local/share/strawberry-trade-operator/firebase-production/cloudflare-setup-v8-defines.json'), 'utf8')),
  };
}

function validateVerificationInput(input) {
  if (!input || typeof input !== 'object' || typeof input.email !== 'string' ||
      input.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
      typeof input.password !== 'string' || input.password.length < 6 || input.password.length > 4096 ||
      typeof input.uid !== 'string' || input.uid.length < 1 || input.uid.length > 128 || /[\s/]/.test(input.uid)) fail('verification-input-invalid');
}

async function postIdentity(fetchFunction, action, apiKey, value) {
  try {
    const response = await fetchFunction(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', redirect: 'error', credentials: 'omit',
      headers: {'content-type': 'application/json'}, body: JSON.stringify(value),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) fail('verification-delivery-failed');
    return await response.json();
  } catch { fail('verification-delivery-failed'); }
}

// All SDKs share the already signed-in local Firebase CLI identity, but refresh
// in memory through Google's SDK. No CLI refresh/write, ADC, key file or public
// Worker service account is used. Injected dependencies are for offline tests.
export async function createProductionClients({loadDependencies = loadProductionDependencies, environment = process.env, now = Date.now} = {}) {
  assertProductionEnvironment(environment);
  let app, db, dependencies, closed = false;
  try {
    dependencies = await loadDependencies();
    const account = dependencies.getAccount();
    if (account?.user?.email?.toLowerCase() !== OPERATOR_EMAIL ||
        typeof account?.tokens?.refresh_token !== 'string' || account.tokens.refresh_token.length < 16) fail('operator-login-required');
    const {UserRefreshClient, GoogleAuth, firebaseApi} = dependencies;
    class SafeOperatorRefreshClient extends UserRefreshClient {
      async refreshTokenNoCache(...args) {
        try { return await super.refreshTokenNoCache(...args); }
        catch { fail('operator-session-refresh-failed'); }
      }
    }
    const oauthClient = new SafeOperatorRefreshClient({
      clientId: firebaseApi.clientId(), clientSecret: firebaseApi.clientSecret(),
      refreshToken: account.tokens.refresh_token,
      endpoints: {oauth2TokenUrl: GOOGLE_TOKEN_URL}, universeDomain: 'googleapis.com',
      // Prevent an authentication failure from silently retrying a mutation.
      forceRefreshOnFailure: false,
    });
    const googleAuth = new GoogleAuth({projectId: PROJECT_ID, authClient: oauthClient, universeDomain: 'googleapis.com'});
    const credential = {
      async getAccessToken() {
        if (closed) fail('operator-clients-closed');
        try {
          const result = await oauthClient.getAccessToken();
          const expiry = oauthClient.credentials?.expiry_date;
          const expiresIn = Math.floor((expiry - now()) / 1000);
          if (typeof result?.token !== 'string' || !result.token || !Number.isFinite(expiry) || expiresIn < 1 || result.token === account.tokens.refresh_token) fail('operator-session-refresh-failed');
          return {access_token: result.token, expires_in: expiresIn};
        } catch { fail('operator-session-refresh-failed'); }
      },
    };
    app = dependencies.initializeApp({projectId: PROJECT_ID, credential}, 'strawberry-local-admin-' + randomUUID());
    const auth = dependencies.getAuth(app);
    // firebase-admin/firestore rejects custom credentials. The underlying
    // official Firestore SDK supports an explicit GoogleAuth instance.
    db = new dependencies.Firestore({projectId: PROJECT_ID, databaseId: DATABASE_ID, preferRest: true, auth: googleAuth, servicePath: 'firestore.googleapis.com', ssl: true});
    return {
      db, auth, projectId: PROJECT_ID, operatorEmail: OPERATOR_EMAIL,
      async sendVerificationEmail(input) {
        if (closed) fail('operator-clients-closed');
        validateVerificationInput(input);
        let configuration;
        try { configuration = await dependencies.readPublicConfiguration(); }
        catch { fail('verification-configuration-unavailable'); }
        if (configuration?.FIREBASE_PROJECT_ID !== PROJECT_ID || configuration.FIREBASE_ANDROID_APP_ID !== ANDROID_APP_ID ||
            (configuration.USE_EMULATORS !== false && configuration.USE_EMULATORS !== 'false') ||
            typeof configuration.FIREBASE_API_KEY !== 'string' || !/^AIza[\w-]{35}$/.test(configuration.FIREBASE_API_KEY)) fail('verification-configuration-invalid');
        const signedIn = await postIdentity(dependencies.fetch, 'signInWithPassword', configuration.FIREBASE_API_KEY, {email: input.email, password: input.password, returnSecureToken: true});
        if (!signedIn || signedIn.localId !== input.uid || typeof signedIn.email !== 'string' || signedIn.email.toLowerCase() !== input.email.toLowerCase() || typeof signedIn.idToken !== 'string' || signedIn.idToken.length < 16) fail('verification-account-mismatch');
        await postIdentity(dependencies.fetch, 'sendOobCode', configuration.FIREBASE_API_KEY, {requestType: 'VERIFY_EMAIL', idToken: signedIn.idToken});
        return {sent: true};
      },
      async close() {
        if (closed) return;
        closed = true;
        const outcomes = await Promise.allSettled([Promise.resolve().then(() => db.terminate()), Promise.resolve().then(() => dependencies.deleteApp(app))]);
        oauthClient.setCredentials({});
        if (outcomes.some(item => item.status === 'rejected')) fail('operator-clients-close-failed');
      },
    };
  } catch (error) {
    if (db) { try { await db.terminate(); } catch {} }
    if (app) { try { await dependencies.deleteApp(app); } catch {} }
    if (error instanceof ProductionCredentialsError) throw error;
    fail('operator-clients-unavailable');
  }
}
