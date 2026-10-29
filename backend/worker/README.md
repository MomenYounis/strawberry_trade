# Optional gateway on Cloudflare Workers Free

**Current deployment, 20 October 2026:** this candidate was subsequently deployed under the owner's explicit reviewed approval. Its runtime identity/secrets and employee-feed index are configured; signed Android setup v8 targets the endpoint. See [current status](../../docs/current-status-ar.md). The source `wrangler.jsonc` deliberately remains a nonpublishing review default; the approved account-specific configuration and receipts are separate. The preparation statements below describe the earlier review boundary, not an instruction to create new accounts or keys again.

This is a locally reviewable alternative to deploying Firebase Cloud Functions. It retains Firebase Auth, default Firestore and the existing trusted accounting gateway. No Cloudflare service/account, production service-account key, billing upgrade or live tenant was created by preparing this directory. The production configuration deliberately has no account ID, public route, real secrets or deployment script. `workers_dev` is false. A real deployment, credentials/IAM and enrollment require a concrete approved run.

## Runtime and free-plan shape

The public Worker forwards each request to one **constant** Durable Object name, `gateway-v1`. It does not derive object names from tenants or user input. `TradingGateway` uses the SQLite-backed Durable Object class/migration required for Free accounts. It does not write ledger data into Durable Object storage; Firestore remains authoritative, with the same transactions, immutable operations, receipts, return/approval locks and audit.

The heavy Admin SDK and gateway work runs inside the Durable Object, whose documented default CPU allowance is 30 seconds per event; the front Worker only forwards. No paid CPU limit is configured. Free supports SQLite-backed objects; the legacy key-value storage backend is not used. The object retains in-memory SDK state only while alive, so correctness relies on Firestore, not its lifetime. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [in-memory lifecycle](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).

Free accounts have separate Worker and Durable Object request/duration allowances. Durable Objects currently include 100,000 requests/day and 13,000 GB-s/day; exceeding a Free limit makes operations fail until reset. Compute duration includes applicable active wall time and is accounted at allocated 128 MB. One always-active object would be approximately 11,059 GB-s/day by simple arithmetic; this is an estimate, not observed metering or a guarantee. Worker requests, other account workloads, Firestore/Auth quotas and abuse also matter. Actual cloud CPU, startup, memory, latency, request/subrequest and quota acceptance remain unmeasured. [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Pinned compatibility workaround

Use `npm ci` with the included lockfile. Tested versions: Node 22.22.2, Wrangler 4.151.2/workerd 1.20261019.1, Firebase Admin 14.5.0, Firestore 9.3.1, google-gax 6.12.1 plus nested 5.0.8, protobufjs 7.6.6. `compatibility.mjs` fails closed if those SDK versions change.

`preferRest: true` alone was **insufficient** in actual workerd. The Node SDK eagerly references `__dirname` and lazily generates protobuf functions during requests. The bundle supplies a harmless root directory constant for unused gRPC paths. Startup precompiles the two gax versions' bundled Firestore/Locations schemas. A narrow in-memory `Root.fromJSON` wrapper reuses startup roots only for the exact two bundled status-schema object identities, because error decoding otherwise generates new functions on every error and incorrectly retries duplicate-create responses. Arbitrary request-time `Function()` remains prohibited. This is a dependency-sensitive shim, not a claim that all Firebase Admin APIs work in Workers. No installed SDK files were edited and no unsafe runtime eval capability was enabled. [Workers crypto support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [startup eval compatibility](https://developers.cloudflare.com/workers/configuration/compatibility-flags/).

After any dependency/runtime upgrade, rerun actual workerd tests including non-success responses, transaction queries, rollback and pagination. Do not remove the status-schema cache based on a successful first write: the isolated probe showed a duplicate create otherwise retried for over 60 seconds.

## Binding contract

Configure these public values in the approved production environment: `FIREBASE_PROJECT_ID`, registered `FIREBASE_ANDROID_APP_ID`, approved `LICENSE_KEY_ID`. Required protected secrets: `FIREBASE_SERVICE_ACCOUNT_JSON`, `LICENSE_PRIVATE_KEY_PEM`, `LICENSE_PUBLIC_KEY_PEM`. The public PEM is not confidential, but is validated alongside the private signer. Every value is bounded to 5,120 bytes before SDK initialization. The service account project must match the configured project; its key must be RSA at least 2,048 bits. Issuer keys must be Ed25519 and match. No binding value or private parse error is returned/logged. Native key, APK signing key, issuer key and Google service-account credential remain separate identities. [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

The runtime signer expects server-readable PKCS#8 PEM in protected secrets; it cannot decrypt the operator tool's encrypted PEM without a separately reviewed import procedure. Never copy production secrets into `.dev.vars`, the repository, APK, chat or logs. A dedicated least-privilege runtime service account still bypasses Firestore rules and can have database-wide access, including the old site's data if that IAM role permits it; client tenant isolation is not an IAM key-compromise boundary. An owner-approved credential and recovery plan are required.

Production refuses all emulator binding variables. The only local exemption requires `WORKER_EMULATOR_ONLY=true`, exact `demo-strawberry-flutter`, and both loopback Auth/Firestore emulator endpoints. Production HTTP requires TLS, a verified Firebase ID token including revocation checks, verified App Check for the fixed Android app ID, and all existing live tenant/member/device/session checks. Direct APK distribution does not require Play Console; a suitable tested App Check provider is a separate setup requirement. A Keystore custom provider would prove enrolled-key possession, not hardware or unmodified-APK integrity. No custom provider or real production attestation is established by this emulator acceptance.

## Reproduce the local test

Install backend dependencies with `npm ci` from `backend`, then run `npm ci` and `npm test` from this directory. Use three local terminals, all in `backend/worker`:

```sh
# Terminal 1: isolated demo emulators, separate from Android's 8080/9099
../node_modules/.bin/firebase emulators:start --only auth,firestore \
  --project demo-strawberry-flutter --config firebase.emulator.json
```

```sh
# Terminal 2: create synthetic fixtures once, then start local workerd
npm run prepare:emulator
npm run dev:emulator
```

```sh
# Terminal 3: real HTTP acceptance through Worker -> SQLite Durable Object
npm run test:emulator
npm run dry-run
```

`prepare:emulator` generates an unusable service-account-shaped RSA fixture and a local Ed25519 issuer, not a Google key. It refuses overwriting an existing file. The fixture is mode 0600 and excluded from source delivery. Its JSON value uses single dotenv quotes; PEM values use escaped newline notation. JSON.stringify alone is not a correct dotenv quoting operation for the account JSON. Restart Wrangler after replacing the fixture file. Retain no local fixtures when packaging, and stop only these local test processes when finished.

The acceptance script creates only synthetic `@example.test` users/tenants on 18080/19099, does not clear another emulator's project, and writes `test-results.local.json`. It tests all seven HTTP endpoints with real emulator ID tokens, device challenges, signed licensing, financial duplicate receipts, attribution, tenant refusal, employee invitation/read restriction/disable/revocation, activation and a 500-record cursor page. An isolated lower-level workerd probe additionally exercised typed SDK values, create/update/merge, transaction query, duplicate-create error mapping and rollback. These are local runtime evidence; they do not prove production IAM, Google token issuance/App Check, cloud free quotas or phone-to-cloud connectivity.

The normal Firebase Functions configurations exclude this whole alternate runtime directory. Keep its `node_modules`, `.wrangler`, `dist`, `.dev.vars*` and local result files out of any delivered archive. Retain source, lockfile, tests and this guide.


## Deployment verification update — 23 October 2026

Use `--minify` for the reviewed production deployment and dry run. Keep the stream-debug preload before the packaging compatibility module, and keep that protobuf warmup at script startup. The Admin gateway runtime is intentionally imported lazily inside the Durable Object request. A local test does not establish Cloudflare startup CPU compliance; validate publication and read the active deployment back.

After changing these imports or Node/SDK versions, rerun the real Worker HTTP acceptance suite and inspect bounded log counts for STREAM/debug payloads. The pinned workerd util.debuglog implementation otherwise enables stream messages even without NODE_DEBUG. See `docs/worker-startup-privacy-review.md` in the project root for evidence and constraints. No payload-bearing Worker log belongs in a delivery archive.
