# Auth and operator recovery: disabled local integration

The private recovery modules now capture an authenticated portable Auth/operator package and restore its users and records into a disabled demo target. They cannot activate a production account, tenant, membership, device or license. This implements a local integration step; provider acceptance and complete-system production activation remain outstanding.

## Supported input

`captureRecoveryAuthorityPackage` accepts the official Firebase CLI JSON account format (`users`, `localId`, `email`, `emailVerified`, `passwordHash`, `salt`, and supported profile metadata), explicit Firebase-modified `SCRYPT` parameters, supplied top-level operator records, an existing 32-byte backup key, the exact required UID inventory, and source/image context. It performs no network calls or credential discovery. See the [official CLI JSON format](https://firebase.google.com/docs/cli/auth) and [Firebase SCRYPT import instructions](https://firebase.google.com/docs/auth/admin/import-users).

Supported identities are email/password accounts. The selected hash configuration contains `algorithm: SCRYPT`, a base64 signer key and salt separator, rounds 1–8 and memory cost 1–14. Hash/salt bytes retain their values. Empty MFA/provider metadata is accepted; linked OAuth, phone/MFA identities, Identity Platform tenant identities, other algorithms, missing hashes, unknown fields, malformed base64 and duplicate UID/email values fail closed. Account UIDs must also satisfy this application's ASCII ID limit of 120 characters. This profile deliberately does not claim universal Firebase account migration.

The context binds source project, default database, tenant, readTime, image ID, financial image manifest SHA-256 and existing key ID. The supplied Auth/operator export is associated with that context, not independently proven to have been captured atomically at readTime. The financial image, Auth export and external operator history still require provider-consistency and completeness acceptance. The module does not fetch a real Auth export or infer missing identities from a damaged database.

Operator records retain exact JSON payloads from these actual application top-level collections:

- `adminEnrollmentHistory`
- `adminTenantHistory`
- `adminDeletions`
- `adminOperations`

Every supplied record must select the same tenant and a single top-level document path. Unknown collections, cross-tenant records, nested paths and unsupported JSON values fail closed. Supplying an empty inventory proves only that the supplied inventory was empty; it does not establish that all required operator history was captured. Original trial dates, entitlement epochs, issuance/transfer/deletion evidence and operation IDs are preserved as inert data; no license or signing key is created.

## Authentication and resource bounds

The canonical package retains the exact original Auth/operator JSON bytes inside encryption. Opening it recomputes both original-byte SHA-256 digests and derives the imported rows from those bytes, rather than trusting detached digest fields beside independently serialized replacement rows. The canonical package uses AES-256-GCM with HKDF-SHA256, a random 12-byte nonce and authenticated source/image context. The key must be supplied; the implementation does not generate a production encryption identity. The parser rejects duplicate JSON keys, dangerous property names, malformed UTF-8, unpaired surrogates, unsafe numbers, unknown schemas and excessive nesting.

| Resource | Hard accepted-input bound |
| --- | --- |
| Users | 1,000 |
| Operator records | 5,000 |
| One source record | 24,576 bytes |
| Plaintext package | 8,388,608 bytes |
| Encrypted JSON envelope | 11,186,176 bytes |
| JSON nesting | 20 |
| Raw JSON nodes / lexical tokens | 100,000 / 400,000, checked before whole-document parsing |
| Auth request / response | 64 KiB / 1 MiB |
| Auth request count / total response bytes | 12,000 / 32 MiB per invocation |
| Auth transport | Exact loopback URL, no redirects or retries, at most 10 seconds per request |
| Target inventory response | 1 MiB |
| Total target inventory wire bytes | 32 MiB |
| Target inventory page | 20 records |
| Execution budget | Default 10 minutes; maximum 30 minutes per invocation |

The 8 MiB plaintext limit includes base64 encoding of the original files plus metadata; therefore the combined original exports have a lower effective capacity. Encoding overhead is counted and excess input is rejected without raising either package limit. The depth/node/token scan runs before whole-document JSON parsing, and account/operator count checks run before normalization. Quoted text is scanned iteratively, avoiding a regular-expression backtracking stack proportional to a large encoded artifact.

This is an explicitly bounded in-memory private Node tool, not a Worker endpoint or an unbounded streaming export. Input parsing, decoded objects and encryption temporarily hold multiple bounded copies. It refuses excess input rather than truncating or silently raising limits. JavaScript strings cannot be reliably erased from process memory; private process/runtime/storage controls still apply. Derived binary keys and plaintext encryption buffers are cleared where possible; secure erasure is not claimed.

## Create-only disabled target and crash recovery

`createRecoveryAuthorityDemoTarget` constructs its own Firestore Admin client and fixed REST Auth transport only after checking both actual process environment and supplied environment. The only target is `demo-strawberry-flutter`, Firestore `127.0.0.1:18180`, Auth `127.0.0.1:19199`, default database, and an explicit synthetic service-account-shaped credential for that demo project. The target rejects ambient ADC and mismatched/live endpoints before inspecting credentials or calling Auth. Arbitrary injected clients cannot acquire the private target brand. The Auth transport sends the explicit emulator-only `owner` credential solely to the hard-coded demo loopback URL; it cannot refresh an OAuth token or select a live host. There is no production override.

Firebase documents that `importUsers` can replace an existing UID and does not perform normal uniqueness checking. Consequently a read-only complete UID/email preflight is followed by a separate ownership reservation, not a direct bulk import. See [the official import collision behavior](https://firebase.google.com/docs/auth/admin/import-users).

For each account, the importer:

1. Refuses preexisting UID/email collisions anywhere in the complete supplied inventory before beginning imports.
2. Creates a Firestore ownership intent containing a random inert reservation marker and source/package digests.
3. Uses the official Auth signup/create method to reserve the UID/email with `disabled: true`, no password, no claims and that marker. Existing accounts are never adopted as reservations.
4. Rechecks the exact owned disabled reservation before importing its original hash/salt and supported profile fields. Each import contains one already reserved account.
5. Forces `disabled: true` and empty custom claims. It does not copy source validSince, sessions, devices, license packages or cached authority.
6. Rereads and compares actual UID, profile, hash and salt bytes before marking the per-user journal verified.

A loss after reservation resumes from its exact ownership marker. An ambiguous accepted import resumes from the reserved journal and exact final disabled user rather than importing again. A foreign, enabled or altered reservation causes refusal. Known reservations must also retain empty photo, salt, phone and MFA metadata; observed additions are not silently cleared by an import. Accepted partial work is retained disabled; the tool never deletes an account or attempts a compensating rollback.

A root journal binds package/context hashes and a fenced lease based on Firestore server readTime. A crashed process must lose its lease before another process resumes. The implementation rechecks its budget and current lease after the final reservation read and immediately before dispatching an import, and before advancing a journal. Auth requests have no automatic retry and a 10-second AbortSignal bounded by the remaining invocation budget. An uncertain write failure retains the lease rather than immediately admitting a competing resume. An abort cannot prove cancellation of a server-accepted RPC: accepted partial work remains disabled and is reverified after lease expiry. Auth and Firestore are not one atomic transaction. An unrelated privileged administrator can still race changes between a read and an Auth import, since Auth offers no conditional ownership precondition on overwriting imports; such changes are refused when observed. This implementation therefore requires an isolated demo target with exclusive cooperating operators. Production concurrency/activation coordination is not implemented.

The `maxUsers` and `maxOperatorRecords` budgets count newly committed work, so a resume can advance past an already verified prefix. Original records and their revisions are not rewritten merely to replay a successful package. Operator history is restored only beneath `authorityRecoveryQuarantine/{imageId}/operatorRecords`, wrapped with `enabled: false`, `activationAllowed: false`, source path and authenticated digests. Source top-level collections are never overwritten.

Final acceptance rechecks every Auth account and uses bounded Firestore `showMissing` inventory to reject altered, extra, nested and orphan quarantine records. The returned state is `verified_quarantine`; `productionRecoveryAccepted` and `activationAllowed` remain false. Byte equality of imported password hashes is not provider proof that a supplied password/hash configuration authenticates correctly. The Auth emulator does not establish real Firebase SCRYPT authentication compatibility.

## Financial image binding

The [image-bound coordinator](recovery-authority-binding-local.md) fully verifies the encrypted financial image before accessing a demo target. It binds the authority envelope to the final financial manifest SHA-256, compares the required and supplied exact UID inventories, and checks the original Auth/operator byte hashes against the financial image's authenticated dependency plan. This avoids a circular dependency between the financial manifest hash and the later encrypted authority package hash. A holder of only the authority encryption key cannot substitute new raw export rows while retaining either stale asserted hashes or the original image-pinned hashes. The wrapper copies inputs before its first await and gives a prepared capability a one-shot lifetime; disposing it clears retained binary secrets. None of these checks accepts provider consistency, object/key durability or activation.

The dependency collector now distinguishes the application's exact server-generated audit shapes from Auth users: tenant creation, trusted device transfer and the five ordinary admin-panel actions preserve their original `trusted-operator` or `local-owner-admin` attribution without requiring fabricated Auth accounts. The authenticated versioned policy records the source row/hash and rederives the classification during image verification. It exempts only the recognized row's top-level `actorUid`; its real `ownerUid`/`uid`, and the same strings used in member or financial identity fields, remain Auth dependencies. Images without this policy retain their previous inventory interpretation. The final actual test includes all three producer shapes alongside exactly two real Auth UIDs.

## Activation planning remains inert

`validateRecoveryAuthorityActivationPlan` validates exact context, UID inventory and separately supplied artifact hashes for provider consistency, independent object restore, key custody, fresh enrollment and financial reconciliation. Missing or mismatched evidence is explicit. Even a complete supplied inventory returns `activationAllowed: false` and `productionActivationImplemented: false`. It is a plan validator, not approval, provider acceptance or an activation capability.

This server recovery package covers only the supplied server-accepted history and identity/operator artifacts. Pending client operations recover only from a separately retained supported client backup. Unsynchronized operations stored only on a lost device are absent from server/Auth exports and cannot be recovered by this mechanism.

Production activation still requires a separately implemented and reviewed workflow that validates accepted financial/object/identity recovery, reconciles source revocation/transfer/license history, coordinates live writes, re-enrolls devices and establishes fresh authority without resetting trials. Production Auth backups/hash parameters, operator records, existing keys and provider acceptance must come from approved external sources. No function here enables an account or activates a recovered tenant.

## Reproducible local verification

Run the pure tests with the approved production Node 22 runtime:

```sh
cd /home/younis/strawberry-trade-annual-review/backend
node --test test/recovery-authority.test.mjs
```

The final combined pure invocation from the repository root additionally covers source capture, object copying, image binding and the exact server-principal policy:

```sh
node --test --test-concurrency=2 \
  backend/test/firestore-recovery-source.test.mjs \
  backend/test/recovery-object-copy.test.mjs \
  backend/test/recovery-authority.test.mjs \
  backend/test/recovery-authority-binding.test.mjs \
  backend/test/recovery-server-principals.test.mjs
```

For the actual local Auth/Firestore suite, use the installed Node 24 development runtime, Java 25, and the existing guarded emulator harness. The harness binds only the demo project's dedicated loopback ports, uses a private synthetic issuer and shuts its services down normally. It does not read operator credentials or use the production gateway. The exact command, versions, source/lock hashes and result are recorded in the integration receipt. From the backend directory, the same guarded invocation is:

```sh
env JAVA_HOME=/usr/lib/jvm/java-25-openjdk \
  PATH=/home/younis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/lib/jvm/java-25-openjdk/bin:/usr/bin:/bin \
  /home/younis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  --input-type=module --eval \
  "import {runEmulatorTests} from './scripts/emulator-test-runner.mjs'; process.exitCode=await runEmulatorTests(['test/recovery-authority.integration.test.mjs']);"
```

The tests cover password-byte preservation with every target account disabled; a separately named source Auth emulator project left untouched; original operator payload/revision preservation; UID/email collision refusal before any import; interrupted reservation; ambiguous accepted import; bounded partial progress on new target handles; actual SIGKILL and lease-expiry resume; source-context/key/ciphertext tamper; and malformed/extra/nested/orphan target records. Test hash bytes and source context are synthetic. Passing these tests does not qualify actual production credentials, provider data retention, PITR alignment, independent storage/key recovery or password sign-in after production activation.

The source uses the official [Auth account lookup](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup), [signup/create](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signUp) and [batch import](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/batchCreate) request formats. Imports request duplicate-identifier checking and overwrite only the previously verified owned reservation. These documents were checked on 7 November 2026. The final receipts below record actual execution, rather than approval of a future test. Local test execution is engineering work and does not require production deployment approval.

| Requirement | Result and evidence |
| --- | --- |
| Bounded capture, authenticated original bytes, unsupported input refusal, object/source integration and exact image/UID binding | **PASS** — [combined pure receipt](../verification/continuation-2026-11-02/final-review/recovery-integration-independent-review-local-pure-nov7.json), [log](../verification/continuation-2026-11-02/final-review/recovery-integration-independent-review-local-pure-nov7.log): 72 passed, 0 failed on Node 22; 23 guarded source hashes unchanged. These suites are counted once: capture 19, object 18, authority 18, binding 11 and server-principal policy 6. |
| Actual disabled Auth/operator restore and complete financial-image integration | **PASS** — [final v5 receipt](../verification/continuation-2026-11-02/final-review/recovery-authority-integration-v5.json), [log](../verification/continuation-2026-11-02/final-review/recovery-authority-integration-v5.log): 16 passed, 0 failed on Node 24.22.1/Java 25 with a 512 MiB Java cap; source/lock hashes unchanged; normal emulator shutdown. Includes independent Admin SDK verification, unchanged source, exact required UID coverage, all three service-principal audit shapes, and independently checked 7,000 − 2,000 = 5,000 remaining debt. |
| Collision refusal, bounded partial progress, altered metadata, post-read timeout, server-accepted response loss and real SIGKILL restart | **PASS** — the same 16-case actual v5 suite; disabled partial accounts survive, uncertain writes retain their lease, and expiry/reverification resumes without importing the accepted account twice. |
| Plan validation without activation | **PASS** — authority pure tests reject missing/mismatched evidence and keep activation false even for a complete supplied plan. |
| Production activation workflow | **FAIL — not implemented.** No enabling override, live enrollment, trial/license/signing-key recreation or production target is exposed. Implementation/review of coordinated activation remains required; approval alone does not supply it. |
| Real provider export/restore, Firebase SCRYPT password sign-in and cross-service readTime completeness | **BLOCKED; actual provider tests NOT RUN.** Approved source artifacts/hash parameters and an isolated provider acceptance environment are unavailable to this local task. Emulator hash-byte equality does not establish those results. |
| Independent provider object/key durability and complete production recovery | **BLOCKED.** Approved durable storage, original key custody and an independently restored provider target are required; supplied evidence and simulated storage do not qualify as acceptance. |

The earlier [v1 failed receipt](../verification/continuation-2026-11-02/final-review/recovery-authority-integration-v1.json) remains as diagnostic evidence of the normalized SDK endpoint-guard defect. It failed before target writes; that guard was corrected and the fixed REST transport and current source passed the final v5 suite. Intermediate v2–v4 receipts remain historical runs of their recorded hashes, not substitutes for final-source acceptance. The [final scope/limits summary](../verification/continuation-2026-11-02/final-review/recovery-authority-final-nov7.json) records the precise remaining provider and activation work.
