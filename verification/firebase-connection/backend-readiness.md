# Backend readiness for the downloaded Android Firebase configuration

Review date: 2026-10-19. The initial review inspected local source; a subsequent read-only Firebase MCP check retrieved the deployed default Firestore rules and environment. It did not deploy, enable billing/APIs, read production business records, create accounts, publish rules, change authentication, or provision a real tenant/device. Root separately completed the Android registration/config and certificate setup described below.

## What the downloaded file completes

`google-services.json` identifies a registered Android client. It does not deploy the callable gateway, enroll a manager/device, establish issuer trust, configure App Check, or sign an APK. Flutter uses explicit `FirebaseOptions` and build definitions in `lib/services/gateway.dart`; placing the JSON in the Android folder alone does not complete this app's runtime setup.

The existing production setup guide identifies project `strawberry-trade-261017-6a49b` and Android package `com.strawberrytrade.strawberry_trade`. The downloaded file must be validated against both before copying/extracting public build values. No private Admin credential is required for the client.

## Existing source and material risks

- `backend/firebase.json` already has Functions codebase `tenant-gateway`, Node 22, region `europe-west1`. A codebase isolates Firebase CLI ownership/deletion grouping; it does not prefix deployed endpoint names. The seven names are `bootstrap`, `syncOperation`, `pullChanges`, `activateLicense`, `setMemberActive`, `acceptInvitation`, and `createEmployeeInvitation`. Read-only deployed-function inventory is required to rule out collisions before any deployment.
- The backend's `firestore.rules` denies **every** direct client read/write. Publishing it to the existing default database would close the previous website's direct client access. Do not run a general deployment from this directory against that project.
- The old website uses default Firestore and legacy global collections. A read-only MCP retrieval on the confirmed production project now verifies that deployed rules are byte-identical to the local legacy snapshot: `/tenants/**` has no permissive matching path and is denied for every direct client identity, including a legacy manager. Snapshot SHA-256: `96fb39261cecf72d08fb6c14249a1d79e800cc32ec1141b8ade5cb37b152cba5`; see `deployed-firestore-default.rules`, `deployed-firestore-provenance.json`, and the security-auditor JSON. This does not authorize or assess privileged Admin SDK endpoints.
- The gateway currently uses `getFirestore()` (default database). A separate named database would require an explicit configured database ID in the server and operator tooling and its own deny-all rules/indexes. Do not claim that isolation exists in the current code.
- `src/index.mjs` enforces App Check outside emulators and binds `LICENSE_PRIVATE_KEY_PEM` from Secret Manager. It does not currently use Firebase parameter definitions for `LICENSE_PUBLIC_KEY_PEM` or `LICENSE_KEY_ID`; those two public server values must be deliberately configured and checked against the APK's `LICENSE_PUBLIC_KEYS`.
- Production `package.json`/function options set maximum three instances per function and concurrency 20. These are resource bounds, not a spending cap. No production billing, latency, attestation, or traffic measurements have occurred.
- **Operator guard gap fixed locally in this turn:** provisioning previously checked only `FIRESTORE_EMULATOR_HOST`; a mixed real-Auth/emulated-Firestore environment could revoke a real user's sessions. Both `provision-tenant.mjs` and `transfer-device.mjs` now enter through `runDemoOperator` before initializing Admin or opening the request. This requires the exact demo project, both loopback endpoints, and no conflicting cloud-project environment variables. There is no production override. Focused tests exercise the real CLI failure boundary as well as a callback that cannot reach Admin when the environment is mixed.
- `provisionTenant` still revokes refresh tokens before its Firestore transaction checks destination existence; it is trusted internal code, not an approved production operator command. Future real onboarding must explicitly review this session-revocation effect. No current operator command is an approved production onboarding procedure.

## Safe local preparation now

1. Validate the downloaded Android config's package/project/client ID; copy only to the intended application; derive an external public build-definition file with `USE_EMULATORS=false`. Do not generate a misleading connected APK with a fake/untrusted production issuer key.
2. Keep production definitions, signing state and issuer state separate from ephemeral emulator fixtures. Validate the build definitions without logging unrelated downloaded files or account credentials.
3. Demo-only operator guard hardening is now implemented; focused tests reject missing/mixed/remote emulator settings and prove the actual CLI refuses before opening the request or accessing Admin. Production rejection is preserved. No separate invitation/activation operator scripts exist; production-authenticated gateway endpoints were correctly not made demo-only.
4. `backend/firebase.production-review.json` now contains **Functions only** and excludes tests/fixture scripts from its bundle; it has no Hosting, Auth, or Firestore default-rule entry. Record the exact codebase, endpoint list, region, source hashes and package lock hash before approval. This file is preparation, not deployment authorization; endpoint collision checks, secret configuration and approval are still required. Do not run an unscoped deployment with the emulator-oriented `firebase.json`.
5. Prepare a non-executing readiness manifest with unresolved items explicitly marked unknown. Do not mark it ready merely because the Android registration is valid.

## Reviewable deployment and isolation choices

Preferred rehearsal: separate owner-approved staging project, synthetic existing verified account, staging-only issuer, staging-only tenant/device. Production project registration does not prohibit using a separate staging backend; choose and document the actual app/project mapping rather than mixing IDs.

For the existing project, choose one approach before preparing a concrete approval request:

**A. New tenant paths in the existing default database:** deployed direct-client denial of `/tenants/**` is now verified read-only. Still verify that no unreviewed Admin endpoint can mutate them, no endpoint-name collision exists, and existing Hosting/Auth/legacy rules are excluded from the deployment. Deploy only the approved new Functions codebase and, separately if needed, the one additive employee change-feed index. Do not replace the legacy rule file. This allows a fresh tenant without migrating old records; it is not a migration of the old business.

**B. Separate named database:** prepare server/operator database selection, independent deny-all rules and indexes, and emulator/integration coverage first. Database creation, paid implications, rules and Functions deployment each require explicit approved target details. This provides a stronger separation from the legacy default database, but is not currently implemented.

Do not migrate legacy data or close old writable paths as a side effect of connecting the new APK. Migration remains the separately reviewed manifest, reconciliation and rollback process in `docs/migration.md`.

## Issuer and Secret Manager contract

- APK signing key, issuer Ed25519 signing key, and device P-256 key are three different identities. Preserve any already distributed release signing identity.
- The local issuer CLI deliberately writes an encrypted private PKCS#8 PEM outside the project. Keep an encrypted backup and the issuance registry separately protected.
- The runtime currently calls `createPrivateKey(secretString)` without a passphrase. Consequently its Secret Manager payload must be a server-readable, unencrypted PKCS#8 Ed25519 PEM, protected by Secret Manager/IAM; the encrypted CLI file cannot be uploaded unchanged and assumed to work. A deliberate private local conversion/import ceremony is required after approval, without printing the key or leaving an unencrypted project file. Alternatively implement and review runtime decryption; do not silently invent a passphrase environment variable.
- `LICENSE_PUBLIC_KEY_PEM` must be the matching public SPKI PEM; `LICENSE_KEY_ID` must be an approved non-test ID; the APK public ring must contain the corresponding raw 32-byte base64url Ed25519 key under the same ID. Check key equality with a synthetic sign/verify operation before publishing.
- Keep production secret access on the selected gateway service account with least privilege. Do not place a private issuer key in Android assets, Dart definitions, `google-services.json`, a public environment file, an archive, chat, or logs.
- Existing backend verification accepts one server key ID/public key at a time while APK supports a public key ring. Rotation must account for this single-active-server-key contract; retaining an old APK verification key alone does not make old activation packages server-acceptable after rotation.

## Required production readiness manifest

The actual reviewable manifest must name: target project and database; endpoint/codebase inventory and source hashes; current rules hash and evidence `/tenants` client access is denied; deployment components explicitly included/excluded; current billing plan and approved costs; region and runtime service account; secret name/version and public key fingerprint (no private value); Android app/package/version/release certificate SHA-256; App Check provider/distribution settings and real-device attestation result; existing verified owner UID; exact tenant ID and public device request; whether this is a fresh empty tenant or a migration; proposed trial start and one-time allocation; operator permissions; checks and rollback triggers.

No live record export is needed to prepare a fresh empty tenant plan. A real UID check/provisioning step must be separately authorized and must not create users implicitly.

## Trusted onboarding preparation

Keep the existing demo tools demo-only. A separately reviewed production operator run should default to a read-only plan, reject emulator variables, require the exact allowlisted project/database and approved manifest hash, validate the verified existing UID and public device key, and refuse an existing or inconsistent tenant. Bind its write phase to the plan and a single reviewed action; preserve a one-time trial registry/policy and audit. Make explicit that token revocation affects the owner's current Auth sessions. Do not add a convenient `ALLOW_PRODUCTION=true` escape hatch to the test scripts.

The device request must come from the actual production-signed installation: debug and release certificates cannot update one another directly, and uninstalling loses the previous installation's Keystore keys. A test emulator's key is not a customer's phone key.

## Acceptance before calling it usable production

Install the approved release-signed APK on an actual phone; verify App Check and real callable bootstrap with the enrolled UID/device; verify signed issuer trust; record locally offline; force-stop/reboot; reconnect and verify one effect per stable operation; produce an Arabic PDF; verify approved backup recovery into the correct scoped tenant; update the same-signed APK without clearing app data. Keep these distinct from the already executed emulator and host test evidence.

Completed during this connection work: the root agent validated/copied the registered Android configuration (app ID `1:713439663809:android:c0565e7ada543b0e2b6640`), prepared a local RSA-3072 release identity and a separate encrypted Ed25519 issuer outside the source project, and registered the public certificate fingerprints. The production project's billing is confirmed **not enabled**. Deployed default Firestore rules were retrieved read-only and confirmed to deny `/tenants/**` while retaining the website's explicit legacy allowances. The demo-operator guard fix passed **22/22 backend unit tests**; the Functions-only review configuration is prepared.

Pending and not implied by the download: approval to enable any paid service; actual server/secret/index deployment; deployed function-name and privileged-Admin-endpoint inventory; server Secret Manager key import and matching public configuration; trusted verified owner/device enrollment; real-device App Check provider/distribution acceptance; production-signed device acceptance/update/offline testing; and any separately approved legacy data migration. Preparing a signed connected APK does not make an unprovisioned backend usable. No production tenant, records or Auth accounts were created or migrated by this review.


## Direct APK update — 2026-10-19

The owner confirmed no Play developer account and APK-only distribution. The prior Play Console account check is no longer a prerequisite: the current official Cloud-only Play Integrity route was used. Both playintegrity.googleapis.com and firebaseappcheck.googleapis.com are enabled. Android-app-specific readback confirms allowUnrecognizedVersion=true, minimum MEETS_DEVICE_INTEGRITY, tokenTTL3600s and default requireLicensed=false. See direct-apk-configuration.json. No global enforcement, database rules, data, accounts, billing or deployment were changed by this setup. Live physical-phone attestation and protected production bootstrap are not yet tested. Billing remains disabled, rechecked through Firebase MCP after provider setup.
