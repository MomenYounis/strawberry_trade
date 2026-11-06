# Compatible backend: prepared locally, deployment pending

Rebuilt on 6 November 2026 after the dependency patch. **No production deployment, login, resource creation,
secret change, billing change or production data operation was performed.** This
document describes the exact locally verified gateway package and the separate
approval required to deploy it. It does not approve the APK, annual scheduling,
archive storage or destructive cleanup.

## Defect and compatibility contract

The immutable original gateway at `e246f436a092616ef2799bb04f969a19fd19ffcc`
rejects the unknown request field **`syncProtocolVersion`** in both
`syncOperation` and `pullChanges`. Setting that field to `1` does not make the
request compatible. This is confirmed against the actual original source in the
Firestore integration suite, rather than a reconstructed legacy mock.

The current client selects a protocol only from authenticated bootstrap metadata.
For v1 it **omits the field entirely**. For v2 it sends the integer
`syncProtocolVersion: 2`. A legacy bootstrap without protocol metadata defaults
to v1. Bootstrap itself does not receive this field. Operation IDs and immutable
payloads are preserved across negotiation, retries, refusal and upgrade; a
protocol refusal never acknowledges or clears a local queued operation.

The prepared backend accepts the following:

| Client/request | Tenant minimum absent or 1 | Tenant minimum 2 |
|---|---|---|
| Supported previous v9 client, field omitted | v1 accepted | Upgrade required; queued operation retained |
| v10/v11 client, explicit integer 1 | v1 accepted | Upgrade required; queued operation retained |
| Supported client, explicit integer 2 | v2 accepted | v2 accepted |
| Current client after legacy bootstrap, field omitted | v1 accepted | Upgrade required until authenticated v2 negotiation |
| Explicit `null`, unsupported integer, string, boolean, array or object | Rejected with `sync-upgrade-required` before I/O | Rejected before I/O |

The default minimum remains 1. Raising it is not part of this deployment and
must not precede the corresponding recovery/fleet acceptance. The protocol does
not grant financial, tenant, membership, device or license authority. Existing
authorization and immutable accounting rules still apply. Snapshot endpoints
require v2. Production snapshot/archive services remain unconfigured in the
Worker and return their guarded unavailable result; this gateway package does
not silently activate them.

The Worker also now consumes a bounded request body before forwarding it to the
Durable Object. A body exceeding 65,536 bytes is refused, including chunked bodies.
This fixes a confirmed early-response stream-lifetime defect found during native
acceptance without relaxing authorization or enabling runtime code evaluation.

## Exact artifacts and reproducible evidence

Artifacts are under
`verification/continuation-2026-11-02/backend-deployment-nov6-retry/`:

| Artifact | SHA-256 | Bytes |
|---|---|---:|
| `compatible-backend-source.tar.gz` | `a4473a6284547ff5ccb8015afd88de0573dcf5f9a7e7890b77ef3dfbdc9703ab` | 56,052 |
| `compatible-backend-dry-run-payload.tar.gz` | `fe3eb536ed163b28a3fe77478cb31fd251f82765bf05b38d5a589436527f8815` | 827,215 |

The source archive contains the **20 exact files** in
[source-inventory.json](../verification/continuation-2026-11-02/backend-deployment-nov6-retry/source-inventory.json)
and an embedded `BUILD-SOURCE-INVENTORY.json`. Its identity is baseline revision
`6383b1a52fc42cd2c8753fa0c6700c55fe29582b` **plus the recorded working-tree file
hashes**, including the strict null-protocol fix and updated dependency locks. The baseline revision alone does
not identify all packaged changes.

The compiled archive contains the minified Worker `index.js`, without a source
map. The pinned lock installs Firebase Admin 14.5.0, google-auth-library 11.3.1
and Wrangler 4.151.2, with scoped transitive security overrides. [Dependency acceptance](dependency-security-review.md) records zero production audit findings, 11 moderate development-only findings, and separate optional-package tooling observations. Both archives exclude credentials, `.env`, `.dev.vars`,
`node_modules` and source maps. Only the Worker's actual local import closure and
the three Worker unit-test files are included. Private annual Node/SQLite
preparation, scheduler and prune runners are absent from the 783 compiled inputs.
This is a gateway deployment package, not a whole-application recovery backup.

| Verification | Result | Evidence |
|---|---|---|
| Clean lockfile install in a fresh private directory | **PASS**, offline, 190 packages; Workerd/esbuild/Wrangler execution checked | [npm-ci-offline.log](../verification/continuation-2026-11-02/backend-deployment-nov6-retry/npm-ci-offline.log) |
| Worker unit suite, including bounded forwarding regression | **PASS 9/9** | [worker-unit-final.log](../verification/continuation-2026-11-02/backend-deployment-nov6-retry/worker-unit-final.log) |
| Strict protocol/direct gateway unit suite | **PASS 28/28** | [strict-protocol-unit.log](../verification/continuation-2026-11-02/backend-deployment/strict-protocol-unit.log) |
| Actual local workerd → SQLite Durable Object → Auth/Firestore emulators | **PASS 95 assertions** | [patched-lock actual HTTP receipt](../verification/continuation-2026-11-02/final-review/dependency-worker-http-java25.json) |
| Exact production-config minified dry run | **PASS**, no upload | [production-config-dry-run.log](../verification/continuation-2026-11-02/backend-deployment-nov6-retry/production-config-dry-run.log) |
| Prebuilt-payload production-config dry run | **PASS**, no upload, byte-identical `index.js` | [prebuilt-payload-dry-run.json](../verification/continuation-2026-11-02/backend-deployment-nov6-retry/prebuilt-payload-dry-run.json) |
| Current production bindings, IAM, App Check and deployment startup CPU | **BLOCKED / NOT RUN** locally | Requires the approved existing production environment; emulator acceptance is narrower |

The 95 HTTP assertions include mixed omitted/v1/v2 clients, explicit null/invalid
version refusal, zero receipt on unsupported requests, unchanged retained queued
bytes, exactly one posting after retry, tenant denial, signed device proof,
invitations, employee price filtering, revocation and 500-record pagination.
They do not establish production App Check, IAM, quota, startup CPU or real-phone
connectivity. The previous `backend-deployment/` package and failed initial `backend-deployment-nov6/` preparation remain historical evidence. This fresh package supersedes their deployment bytes. The direct 28-test result is historical; the current 163-test backend suite and 95 actual HTTP checks also cover the contract after the lock changes.

To reproduce local preparation without deployment, choose a fresh evidence
directory; the packager refuses to overwrite sealed evidence:

```bash
cd /home/younis/strawberry-trade-annual-review
python3 tools/annual-review/package-compatible-backend.py \
  --output-dir verification/backend-reproduction-REVIEW
```

It copies the exact source closure to a private temporary directory, uses
`npm ci --offline --ignore-scripts --include=optional --no-audit --no-fund`, runs the Worker tests,
and executes Wrangler with `--dry-run --no-upload-source-maps`. Its environment
does not inherit cloud tokens, ADC, issuer keys or service-account bindings; the
configuration store is isolated. It removes only its own temporary directory.
The offline package cache must already contain the locked platform dependencies. An npm exit code of zero alone is insufficient: explicit `workerd --version`, `esbuild --version` and `wrangler --version` checks must pass.

## Production prerequisites and approval boundary

Before approval, an operator must confirm the **existing** intended target:

- Worker `strawberry-tenant-gateway` in configured account
  `c9e7af798c5f97976ecdb07e3fc086f6`, using
  `config/wrangler.production.json` with compatibility date `2026-10-19`.
- Firebase project `strawberry-trade-261017-6a49b` and registered Android app
  `1:713439663809:android:c0565e7ada543b0e2b6640`.
- Existing protected `FIREBASE_SERVICE_ACCOUNT_JSON`,
  `LICENSE_PRIVATE_KEY_PEM` and `LICENSE_PUBLIC_KEY_PEM` bindings. Their identities
  must match the project and approved `issuer-v1` public key. Reuse them; do not
  create a replacement issuer, Android signing key, service account or account.
- Existing Firestore rules/indexes and IAM are adequate for the supported routes;
  confirm the employee feed index. This Worker deployment does not deploy
  Firestore rules/indexes or grant permissions.
- Record the current deployment/version, effective bindings and rollback version
  before changing anything. Choose a rollback version compatible with the
  supported client fleet and preserve its configuration. A read-only query on 6 November was [BLOCKED by unavailable existing authentication](../verification/continuation-2026-11-02/final-review/backend-production-readonly-nov6.json); no login or production change was attempted.
- Keep the existing Durable Object binding/class `GATEWAY`/`TradingGateway` and
  migration tag `v1`. No new migration, R2 bucket/binding, cron trigger, tenant
  minimum protocol, annual close or deletion setting is included.

The smallest owner action is approval of the **named existing target and these
exact artifact/configuration hashes**, after the independent APK/native/core
release gates pass. The operator also needs access to the existing deployment
identity and rollback-version record. No approval to activate annual storage,
scheduling, billing, close or deletion is implied.

## Reviewed deployment procedure — do not execute without approval

Use a clean review directory and verify archive hashes before extracting. The
following is the concrete deployment plan, **not a command executed during this
engineering task**:

```bash
# REVIEW ONLY: obtain explicit approval for this package and existing target.
# From the backend-deployment-nov6-retry evidence directory:
sha256sum --check SHA256SUMS

# Extract the source archive under REVIEW_ROOT/source and payload archive under
# REVIEW_ROOT/payload, using a tool that refuses path traversal/symlink escapes.
# Install the locked deployment tooling in REVIEW_ROOT/source/backend/worker:
npm ci --ignore-scripts --include=optional --no-audit --no-fund
npm test

# Run from REVIEW_ROOT/source/backend/worker. First repeat the safe local check:
./node_modules/.bin/wrangler deploy ../../../payload/index.js \
  --env= --config ../../config/wrangler.production.json --no-bundle \
  --dry-run --no-upload-source-maps --outdir ../../../payload-review

# Approved operation only, using the same reviewed prebuilt bytes/configuration:
./node_modules/.bin/wrangler deploy ../../../payload/index.js \
  --env= --config ../../config/wrangler.production.json --no-bundle \
  --strict --no-upload-source-maps \
  --message 'Reviewed compatible gateway 2026-11-06'
```

`REVIEW_ROOT` is a chosen task directory, not a shell environment override.
No `--secrets-file`, login, secret creation, new resource, index deployment,
schedule or cleanup command is part of this plan. If existing bindings or
configuration differ, stop and revise the concrete review rather than replacing
identities or copying unknown bindings. Record Wrangler's deployment/version ID,
the reviewed artifact hashes and the effective public target. Check the deployed
version and read-only health/bootstrap through the exact intended APK/backend
configuration before distribution. Financial smoke-test writes require a
separately authorized synthetic business scope; never use a client's live records
as deployment probes.

## Rollback procedure — separate production operation

If rollout fails, stop client distribution, keep local queues and all server
financial records intact, and inspect the recorded deployment error/version.
No data reset, queue clear, receipt deletion or credential replacement is a
rollback step. Reissuing a supported request uses its original operation ID.

An approved operator can restore the previously recorded **compatible** version:

```bash
# REVIEW ONLY; replace the placeholder with the verified recorded version ID.
./node_modules/.bin/wrangler rollback PRIOR_COMPATIBLE_VERSION_ID \
  --env= --config ../../config/wrangler.production.json \
  --message 'Restore recorded compatible gateway after reviewed rollout failure'
```

No rollback has been executed. A prior original strict backend cannot support
v10/v11 requests that include `syncProtocolVersion`, even when it equals 1. Do
not label that rollback compatible with those clients. The current client can
renegotiate v1 and omit the field against the original backend, but pending
operations must remain queued until a supported authenticated session succeeds.
If the fleet includes v10/v11 and no compatible previous version is recorded,
the rollback plan is **BLOCKED** until a compatible fallback package/version is
approved; an unreviewed old-version rollback is not an acceptance shortcut.

Worker rollback changes code/version, not Firestore financial history, device
enrollment, license epochs or accepted operation receipts. Those records must not
be restored to an earlier point simply because the Worker code is rolled back.
Recheck version/target and read-only authenticated behavior after rollback; keep
annual close and cleanup disabled throughout.
