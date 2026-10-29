# Developer guide

This is the independent Flutter Android implementation. The previous website is evidence for behavior and migration only; neither its DOM nor its JavaScript accounting engine runs inside the app. Arabic is the fixed application locale, even on an English-configured device. User instructions are in `user-guide-ar.md`; production boundaries and costs are in `backend.md`.

## Toolchain and reproducibility

The implementation workspace used the following versions. Installation is not proof that an Android acceptance test passed; read `test-results.md` for executed outcomes.

| Component | Version / configuration |
|---|---|
| Flutter stable | 3.47.2 |
| Dart | 3.13.2, sound null safety |
| Java for Android build | Amazon Corretto 17.0.20; JVM target 17 |
| Android | SDK platform 36 and build tools 36.0.0 installed; minimum API 24; API 35 emulator image prepared |
| Android emulator | 37.2.12; emulator archive integrity checked on extraction; API 35 system-image archive matched its published SHA-1 |
| Android Gradle plugin / wrapper | 9.1.0 / Gradle 9.3.1, pinned in Android project |
| Kotlin Gradle plugin | 2.4.0 |
| Node backend / issuer | Node 22; backend execution verified with 22.22.2 |
| Backend Firebase CLI | Pinned via backend lockfile, 15.34.0 |

Use Java 17 for this Android project even if the host's default Java is newer. Configure your installed Flutter SDK and Android SDK using standard Flutter tooling; generated `android/local.properties` contains machine-local paths and is excluded. Install/accept required Android SDK components using your own configured SDK. SwiftShader crashed on this Linux host; the emulator subsequently booted using host graphics with Mesa llvmpipe. Executed emulator acceptance is recorded separately from physical-phone and production acceptance in `test-results.md`.

Direct Flutter dependency versions are in `pubspec.yaml`; full resolution is in `pubspec.lock`. Node resolution is in `backend/package-lock.json`. Keep lockfiles in the review archive. There is no Drift/Riverpod generator, `build_runner`, generated database source or missing code-generation step. Riverpod is used through ordinary providers/controllers. Bundled Arabic fonts allow offline UI/PDF rendering; essential behavior does not load a CDN or remote page.

## Architecture

Riverpod provides session state and dependency wiring without adding a large event/framework layer. The controller exposes readiness, authority and synchronization status. UI reads local data; a successful save is shown only after the SQLite transaction succeeds. A guarded stable draft ID prevents repeated-tap duplication. Saving an operation, its outbox entry and local audit happens together. Drafts and preferences live in SQLite, scoped by user/tenant.

`domain/ledger.dart` defines integer money (1/100 EGP), quantity (1/1000 unit), strict digit/decimal parsing, half-up totals, invoice/return invariants, reversals, statements and payroll. Domain units can run without FlutterFire/network. Financial history is immutable; correction entries record why an old effect is reversed. Effective-dated salary terms prevent today's salary rewriting prior periods. Non-inventory financial labels deliberately avoid an actual-profit claim.

`data/ledger_store.dart` is the repository and primary durable data source. Current schema is **2**. Schema 1 creates scope, parties, employees, salary terms, entries, submissions, outbox, drafts, preferences and audit. Schema 2 adds durable `next_attempt_ms` scheduling, its outbox index and conflict records. Indexed party/date/original/creator relationships support local browsing and return validation; salary terms have a unique employee/effective-month relationship. Foreign keys and business validation operate together. Migrations preserve existing rows and pending stable IDs; schema upgrades must never drop/recreate the ledger.

Android SQLCipher uses a random per-account/tenant database password. A Kotlin channel wraps it with an Android Keystore AES-GCM key; the P-256 installation signing key also stays in Keystore. Protected state is in no-backup storage and Android backups/device transfers are excluded. The app verifies `PRAGMA cipher_version` and fails closed without the claimed encryption. Host SQLite tests are intentionally unencrypted and **cannot establish native SQLCipher or Keystore correctness**. Native integration tests exercise those real mechanisms; their execution status must be recorded separately.

`services/gateway.dart` uses FlutterFire Auth and authenticated callable Functions. `AppController` owns a single durable send/acknowledgment lifecycle; no Firestore client write queue runs in parallel. Stable operation ID/digest receipts make retries idempotent. Session generation and tenant/UID/device binding prevent late responses acknowledging another account's queue. Launch/foreground/connectivity/manual actions resume work; force-stop means no work until the next actual execution opportunity. Connectivity is a hint; server acceptance is the acknowledgment.

Backend authorization checks verified Auth ownership, revocation, tenant membership, enrolled device and proof session. The employee feed is built without manager financial payloads. Atomic approval locks and cumulative return counters protect connected global invariants; pending local actions remain provisional until validated. Full API and license-expiration queue policy are documented in `backend.md`.

## Host checks

Run from the Flutter root:

```sh
flutter pub get
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze
flutter test
```

The format check is read-only; use `dart format lib test integration_test` when intentionally formatting changed code. Actual disk SQLite tests cover transaction rollback, migration, close/reopen, durable queue, scoping and backup relationships. Domain tests use known integer results rather than merely mirroring implementation; controller/widget tests cover readiness/save/session/error behavior. Licensing tests cover signatures, epochs, device binding and time manipulation with test clocks. A fake clock is not an actual phone reboot.

Run these in the indicated subdirectory:

```sh
# backend/
npm ci
npm test
npm run test:integration

# tools/license-issuer/
npm test
```

The isolated legacy baseline was rerun with **30 client assertions and 42 rules tests passed**. The fresh rules run used a separate demo project on Firestore `127.0.0.1:8181`, hub `4411`, logging `4511` and websocket `9151`, with UI disabled and host/project assertions before executing the unchanged tests. Its source hashes match the original copy; the current Android acceptance backend was untouched. Prior original stdout is retained separately from the fresh final log. The new backend suite contains **18 unit and 26 emulator integration tests** (19 gateway/enrollment cases and 7 shipment cases); three unit cases cover session-isolated synthetic tenant fixtures and loopback-only helper restrictions. Read `test-results.md` for final outcomes, logs and provenance, including the complete Flutter suite and build/device evidence. Do not sum overlapping subsets into a fabricated total.

## Android emulator development

### External no-card gateway candidate

The owner requires a no-card route. See `no-card-backend.md` and `backend/worker/README.md` for the pinned Cloudflare Workers Free / SQLite Durable Object candidate, runtime acceptance and deployment boundaries. The optional public `GATEWAY_BASE_URL` uses FlutterFire `httpsCallableFromUrl`; Auth and App Check tokens remain SDK-managed. Leaving it empty preserves the earlier Functions destination. Generate a new external definitions file with `tools/firebase-config/cli.mjs --gateway-url ...` only for a reviewed endpoint; old APKs do not acquire a new destination automatically.

`integration_test/external_gateway_test.dart` exercises the native URL override with the guarded `backend/scripts/external-native-demo.mjs` fixture. It requires the same matching temporary public definitions and real Auth/Firestore emulators, and uses `--no-uninstall`. The runner binds only loopback, refuses occupied ports and non-demo inherited projects, and never accepts a production override. Native HTTP acceptance and local workerd/Durable Object acceptance are separate tests; neither proves production phone attestation or cloud quotas. Their final evidence is in `verification/no-card/` and the appended test report. Never package `.dev.vars*`, worker `dist/`, `.wrangler/`, node_modules, synthetic issuer secrets or generated session definitions.

In terminal A, from `backend/`:

```sh
npm run emulators
```

This creates a session-only issuer and public `integration-test-defines.json`, starts project `demo-strawberry-flutter`, Functions region `europe-west1`, and the loopback synthetic seed helper. Do not run backend integration tests simultaneously: they clear the demo project's records. Leave this terminal running throughout the Android gateway test. Restarting creates a different issuer; regenerate the test APK/defines rather than expecting old trial packages to validate under unrelated keys.

In terminal B, from the Flutter root:

```sh
flutter devices
flutter build apk --debug --dart-define-from-file=integration-test-defines.json
flutter test integration_test/local_persistence_test.dart -d DEVICE_ID --no-uninstall --dart-define-from-file=integration-test-defines.json
```

Replace `DEVICE_ID` with the actual attached Android device/emulator ID. A debug APK normally appears at `build/app/outputs/flutter-apk/app-debug.apk`; its presence and checksum must be verified after the build succeeds. The debug manifest permits HTTP only for local emulator development. Main/release manifest disables cleartext and system backup. Inspect the merged manifest and dependency components of each final APK; a source manifest or a previous debug inspection does not establish the flags of another release artifact.

The Android emulator reaches the host as `10.0.2.2`. A physical USB phone can use `adb reverse tcp:9099 tcp:9099`, `adb reverse tcp:5001 tcp:5001`, and `adb reverse tcp:8008 tcp:8008`, together with `--dart-define=EMULATOR_HOST=127.0.0.1` after the definitions-file option. Keep the services loopback-only; do not expose the synthetic seed helper to a network. The phone and its test account must be disposable synthetic fixtures.

`firebase_gateway_test.dart` exercises the native vertical path: Keystore public request, trusted synthetic setup, SQLCipher save/outbox, disk reopen, actual callable server acceptance with duplicate retry, bundled Arabic PDF, native sharing, ordinary controller setup and an offline committed invoice. It requires a small Android driver or a present operator. `local_persistence_test.dart` separately exercises Keystore signing, protected files, SQLCipher, relationships and migration using real native APIs. These commands describe the procedure; executed results belong in `test-results.md`.

For the gateway test, keep terminal A running. From the Flutter root in terminal B, **enable the network first**, truncate the gateway log, then start the driver before launching Flutter:

```sh
mkdir -p verification
adb -s DEVICE_ID shell cmd connectivity airplane-mode disable
adb -s DEVICE_ID shell svc wifi enable
: > verification/android-firebase-integration.log
ANDROID_SERIAL=DEVICE_ID python3 integration_test/drive_android_fixture.py \
  --adb adb \
  --log verification/android-firebase-integration.log \
  --evidence verification
```

The driver stays in the foreground watching that log. `ANDROID_SERIAL` selects the same Android target as Flutter; replace `DEVICE_ID` in both terminals. If `adb` is not on the path, pass its absolute SDK path. With the driver already watching, use terminal C from the same Flutter root:

```sh
flutter test integration_test/firebase_gateway_test.dart -d DEVICE_ID \
  --no-uninstall --dart-define-from-file=integration-test-defines.json \
  > verification/android-firebase-integration.log 2>&1
```

The redirection deliberately uses the same freshly truncated log. At `ANDROID_PDF_SHARE_CHOOSER`, the driver captures `verification/android-share-chooser.png`, presses Back and chooses no recipient. At `ANDROID_OFFLINE_SAVE_READY`, it enables airplane mode and disables Wi-Fi before the test's five-second save window. It then waits for `ANDROID_OFFLINE_OPERATION_COMMITTED`. The expected final state is **network off, airplane mode on**. A driver marker alone is not a passed test: also check Flutter's final result. The driver times out after about ten minutes and does not send a file or message.

Without the driver, dismiss the PDF chooser manually without choosing a destination, then enable airplane mode and disable Wi-Fi within five seconds of `ANDROID_OFFLINE_SAVE_READY` in the log. Leave the network off for recovery. Do not run the gateway command unattended without either method; it otherwise waits for the native chooser and cannot establish the intended offline-save conditions.

## Restart and update acceptance

`local_persistence_test.dart` supports a persistent fixture across test invocations:

```sh
flutter test integration_test/local_persistence_test.dart -d DEVICE_ID --no-uninstall --dart-define=PERSISTENCE_PHASE=seed
# Install a newer build over the same package with the same signing certificate.
flutter test integration_test/local_persistence_test.dart -d DEVICE_ID --no-uninstall --dart-define=PERSISTENCE_PHASE=verify
```

Use the same installation/user data and signing identity; do not uninstall or clear data between phases. Record installed version codes and exact install method. Running both phases without an APK replacement proves restart/reopen only, not update survival. Before/after force-stop, network disconnect, process-kill timing and OS restart need actual device evidence. The fixture must retain committed operations, outbox IDs and the installation key.

After the gateway fixture has passed and the network remains off, `offline_recovery_test.dart` opens the normal cached session and SQLCipher scope, checks the saved invoice and pending stable ID, generates a PDF locally, and mounts the ordinary Arabic app. Use the **same public definitions file and issuer as that fixture**:

```sh
adb -s DEVICE_ID shell am force-stop com.strawberrytrade.strawberry_trade
flutter test integration_test/offline_recovery_test.dart -d DEVICE_ID \
  --no-uninstall --dart-define-from-file=integration-test-defines.json \
  > verification/android-offline-recovery.log 2>&1
```

For reboot evidence, reboot that Android target, wait until Android has fully booted, confirm airplane mode/Wi-Fi remain off, then run the same recovery command. For APK-update evidence, install a newer build over it with the same package and signing certificate before recovery. Preserve the Keystore identity, scoped database and queued operation; never uninstall or clear data to make recovery pass.

**Do not restart `npm run emulators` or regenerate issuer/public definitions before checking the cached license offline.** A wrapper restart intentionally creates a new issuer and synthetic tenant namespace; compiling old cached data against that unrelated public key is a different experiment. If the server has stopped, complete offline recovery with its saved matching definitions first. Only then start a fresh wrapper and rebuild a new gateway fixture. Older local scopes are retained.

For manual acceptance use English device language, Arabic UI/digits, narrow screen/font scaling, keyboard/back/rotation, long statements/PDF pagination and native sharing. Exercise manager/employee enrollment, two tenants, duplicate/concurrent sync, expiration/renewal, different-device restoration and old-record search. Multi-season performance and full-storage behavior need measured evidence; unit mocks alone do not establish those paths.

## Production configuration and signing

### Completed local preparation — 2026-10-19

The owner downloaded the real Android `google-services.json`. It now resides at `android/app/google-services.json` and matches the existing project and Android package:

| Item | Current value |
|---|---|
| Firebase project | `strawberry-trade-261017-6a49b` |
| Project number / sender ID | `713439663809` |
| Android package / application ID | `com.strawberrytrade.strawberry_trade` |
| Android Firebase app ID | `1:713439663809:android:c0565e7ada543b0e2b6640` |
| External production definitions | `/home/younis/.local/share/strawberry-trade-operator/firebase-production/production-defines.json` |
| External release signing key | `/home/younis/.local/share/strawberry-trade-operator/android-release.jks` |
| Signing alias / key type | `strawberry-release-v1`, RSA 3072, JKS |
| External encrypted license issuer key | `/home/younis/.local/share/strawberry-trade-operator/issuer-v1.pem` |
| Issuer public file / key ID | `/home/younis/.local/share/strawberry-trade-operator/issuer-v1-public.json`, `issuer-v1` |

The release and issuer keys have already been created. Do not rerun key generation or replace them to work around a build/update problem. Their passwords were stored in the desktop Secret Service keyring under the distinct purposes `android-release-v1` and `license-issuer-v1`. They must not be placed in source, logs, shell arguments or chat. The issuer private key is encrypted; it is separate from both the APK signing key and the device's Keystore keys. The issuer's **public** trust map is part of the external Dart definitions. Preserve encrypted off-device backups of the operator files and a safe way to recover their passwords; this backup is still required.

The new release certificate's SHA-1 and SHA-256 fingerprints have been registered on the Firebase Android app. Its public SHA-256 fingerprint is:

```text
BF:1C:B6:37:7B:E0:C3:7C:AD:31:81:1B:55:7A:C3:2B:68:6F:FD:C7:57:30:77:8E:DB:84:88:D2:BD:B3:D8:2B
```

Firebase Android certificate registration is distinct from successful App Check registration/attestation. No production attestation or physical-device connection is established by that registration.

### Configuration path and checks

`FirebaseGateway` initializes with explicit `FirebaseOptions` from Dart definitions. The copied Android JSON is the validated public configuration input; the project deliberately does not enable the Google Services Gradle plugin. Enabling it unconditionally with the production JSON would let `FirebaseInitProvider` initialize the production default app before Dart runs, conflicting with the demo/emulator project's default-app isolation checks. Native Firebase dependencies are provided by the Flutter plugins; do not add a second unreviewed BoM or initialization path. See [Firebase programmatic configuration](https://firebase.google.com/docs/projects/multiprojects) and [Flutter initialization](https://firebase.google.com/docs/flutter/setup#initialize-firebase).

Default `USE_EMULATORS` remains **true**. The generated external production definitions explicitly set it to the string `false` and supply `FIREBASE_PROJECT_ID`, `FIREBASE_ANDROID_APP_ID`, `FIREBASE_API_KEY`, `FIREBASE_SENDER_ID`, and JSON-encoded `LICENSE_PUBLIC_KEYS`. Public client Firebase configuration is not an Admin credential. A web app ID must never be used for Android. No private signing key enters Dart definitions or the APK.

The reusable local tool at `tools/firebase-config/` validates exactly one package-matching Android client, matching project number/app ID/sender ID, a non-demo project, the public API key, and a nonempty map of canonical raw 32-byte Ed25519 public keys. It also accepts the existing issuer tool's public output and verifies that an included SPKI public key matches. It refuses existing output files and paths inside the application source, including parent-directory symlink redirection. Its 10 focused Node checks passed during configuration preparation. Run them independently with:

```sh
node --test tools/firebase-config/config.test.mjs
```

The production file above has already been generated. For a deliberate later review or rotation, choose a **new** output path; the tool will not overwrite the reviewed file:

```sh
node tools/firebase-config/cli.mjs \
  --google-services android/app/google-services.json \
  --license-public-keys /home/younis/.local/share/strawberry-trade-operator/issuer-v1-public.json \
  --project strawberry-trade-261017-6a49b \
  --out /home/younis/.local/share/strawberry-trade-operator/firebase-production/production-defines-reviewed-next.json
```

A new trust key must be reviewed against the backend issuer before using the resulting build. Local format/configuration validation does not prove that the live API key restrictions, attestation, callable endpoints or membership are correct.

### Release signing and the setup artifact

Gradle first reads the external properties path in `STRAWBERRY_SIGNING_PROPERTIES`; if the variable is absent, it falls back to local-only `android/key.properties`. An explicitly supplied nonexistent external path fails closed. The release build does **not** fall back to debug signing. Without a configured signing identity, the historical build could produce an unsigned review artifact.

An external, access-controlled signing properties file has this shape; populate passwords locally from the Secret Service keyring without printing them:

```properties
storeFile=/home/younis/.local/share/strawberry-trade-operator/android-release.jks
storePassword=SET_LOCALLY
keyAlias=strawberry-release-v1
keyPassword=SET_LOCALLY
```

Keep the file outside source with mode 0600, remove temporary signing-session files when no build uses them, and retain passwords only in the intended secret store. A build uses its path, not password arguments:

```sh
STRAWBERRY_SIGNING_PROPERTIES=/absolute/operator/signing-session/key.properties \
  flutter build apk --release \
  --dart-define-from-file=/home/younis/.local/share/strawberry-trade-operator/firebase-production/production-defines.json
```

Version code **7**, signed using this new certificate and real Firebase configuration, built successfully on 2026-10-19. The separate output is `../strawberry-trade-firebase-setup.apk`, 77,086,124 bytes, SHA-256 `9512f40cd4dc80092b960fbdfaf14081c766d7259afb4a0d8b1a875527dacc3d`. Android build-tools verified its release certificate, package and version; a packaging check confirmed the intended project/app/issuer in all three ABI app libraries and no local private key or password in the APK. Logs and the bounded verification report are in `verification/firebase-connection/`. This setup artifact is not yet a usable production service: no live-device attestation or production backend acceptance was performed. The prior version-6 emulator test APK and unsigned review APK are separate artifacts; their earlier acceptance results do not establish acceptance of this new configuration.

Keep the default dependency/tooling preparation enabled when changing build mode. With the pinned Flutter 3.47.2 SDK, `--no-pub` also skips regeneration of the native plugin registrant. A release build immediately after a debug build or native integration test can then reference the development-only `integration_test` plugin even though Gradle correctly excludes it from release. Run the release command above **without `--no-pub`**, and let it finish before another Flutter build, native test, or dependency command runs against the same checkout. A separate `flutter pub get` followed by `flutter build apk --release --no-pub` does not fix the mode mismatch, because dependency preparation alone generates the development registrant. Keep `integration_test` under `dev_dependencies`; do not edit the generated registrant or add the test plugin to release dependencies. Use the same default tooling preparation when switching back to native integration testing.

Inspect signatures with Android build-tools `apksigner verify --print-certs APK_PATH`, inspect the merged APK, and record its SHA-256, version, package and certificate. A command in this guide is not evidence that it was executed or passed. The new release certificate differs from the debug certificate, so it cannot update the previous debug-signed installation directly. If that installation contains data that matters, export and review the transition before removing it. Uninstalling loses its Keystore identity; device enrollment and licensing do not transfer automatically. Future release updates must retain the approved package and release certificate.

### Remaining live-service requirements

Billing was checked on 2026-10-19 and was **not enabled**. Blaze and the deployment/cost boundary still need review and approval. Prepare a Functions-only deployment and the approved issuer secret separately; do not replace the existing website's Firestore rules or migrate its data as part of Android client configuration. The new source's direct-client-deny rules would also close legacy paths. Follow the migration/rollback review before any such rule change.

The owner confirmed direct APK distribution and no Google Play developer account. Keep the built-in provider: the current [Android setup guide](https://developer.android.com/google/play/integrity/setup), updated 2026-10-16, permits enabling Play Integrity API through Google Cloud Console and then integrating without Play Console linking. Linking is recommended for additional options, testing/reporting and quota increases; it is not an unconditional prerequisite for this base Cloud-only route. No paid Play developer account is being created. The base project quota is 10,000 daily token requests and 10,000 decryptions; monitor it rather than assuming a sideload-only project can obtain a Play-distribution quota increase.

The source pins `firebase_app_check 0.5.0` and activates Play Integrity after Firebase initialization for production connected setup/sync. Callable Functions enforce App Check outside emulators. Local ledger opening and permitted commits never wait for an App Check token. The provider uses the Firebase sender/project number, a Firebase-generated nonce, Play Integrity and Firebase's token exchange; it does not require a Play-published application identifier. See the [official Android provider implementation](https://github.com/firebase/firebase-android-sdk/blob/main/appcheck/firebase-appcheck-playintegrity/src/main/java/com/google/firebase/appcheck/playintegrity/internal/PlayIntegrityAppCheckProvider.java).

The authenticated 2026-10-19 preflight found `playintegrity.googleapis.com` and `firebaseappcheck.googleapis.com` disabled and this Android app's provider at `NO_INTEGRITY`. Both APIs were then enabled and only this Android app's off-Play provider policy was updated. Authenticated readback succeeded: both services are `ENABLED`, `tokenTtl=3600s`, `allowUnrecognizedVersion=true`, and `MEETS_DEVICE_INTEGRITY`. The API returned `accountDetails={}`, which represents the documented default `requireLicensed=false`; it is not a missing Play-license setup step. The bounded readback report is `verification/firebase-connection/direct-apk-configuration.json`, with `setupConfigured=true` and `productionDeviceTestPassed=false`. This action did not enable billing, deploy Functions, change database rules, create accounts, migrate data or change App Check enforcement for other Firebase products.

The effective verified off-Play policy is (showing the default licensing Boolean explicitly):

```json
{
  "tokenTtl": "3600s",
  "appIntegrity": {"allowUnrecognizedVersion": true},
  "deviceIntegrity": {"minDeviceRecognitionLevel": "MEETS_DEVICE_INTEGRITY"},
  "accountDetails": {"requireLicensed": false}
}
```

These are Firebase's outside-Play controls: no Play recognition or license requirement, with explicit device integrity. Omitting the device level defaults to `NO_INTEGRITY`; Basic/Strong optional verdicts need separate opt-ins and should not be substituted blindly. Keep the registered release SHA-256. [Off-Play provider guidance](https://firebase.google.com/docs/app-check/android/play-integrity-provider), [official policy resource](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.playIntegrityConfig). The Cloud-only built-in route follows these supported mechanisms. Subsequent version-8 protected bootstrap for the approved owner's physical phone succeeded, supported by matching server challenge/session evidence and the owner's home-open report; raw App Check/session tokens were not captured. No custom provider or hardware-attestation verifier was added.

Android's separate developer-identity/package registration rollout must not be confused with Play Integrity or treated as proof that direct APKs never need registration. The current timeline starts protections for certified Android devices in Brazil, Indonesia, Singapore and Thailand on 2026-09-30 and expands globally in 2027; Egypt is not in that initial list. Recheck the rules for actual target countries/channels before broader distribution. This is a separate distribution-planning concern, not a reason to create a paid Play account for the current Firebase setup. [Official rollout and available paths](https://developer.android.com/developer-verification).

A registered physical Android phone must obtain a real App Check token and complete protected, signed bootstrap with an existing verified owner, its deliberately provisioned tenant and enrolled device. The first approved owner completed that protected flow on 20 October; the owner also reported offline close/reopen into home without login. This is separate from emulator/certificate evidence and does not establish live invoice synchronization/retry, PDF or update with business records. Do not print tokens or private material, disable checks or ship a debug provider to work around another unconfigured client. Encrypted off-device key backup and the remaining business-operation acceptance are still required.

## Separate owner enrollment tools

[`tools/production-operator`](../tools/production-operator/README.md) contains the plan-only default CLI and a separate opt-in application module/CLI, verified locally by **30 passing tests**. The application entry point has no default action: explicit target/default database, exact rebuilt plan/hash, real specific approval, credential stdin and durable receipt are required. Approval must identify the existing verified owner UID/email, tenant and manually verified phone public key, and acknowledge project-wide session revocation and the one-time 30×24-hour trial. A prior deployment approval or generated plan is insufficient.

The module rechecks the live owner before revocation and every final transaction attempt, reads owner history plus all four document preconditions, and derives trial time from the latest valid Firestore `readTime` in that final transaction. Read metadata need not be identical. Its receipt preserves the original time across retries. Uncertain Auth outcomes stop for review instead of automatically revoking again; exact committed enrollment can be recognized without a new trial. Auth revocation and Firestore creation are separate service effects, and deleted or unrelated business history still requires manual investigation. The approved owner enrollment subsequently completed with four matching records and unchanged revocation time during recovery; local tests alone do not authorize another production run. The demo-only backend scripts remain unchanged.

## Review archive hygiene

Include `lib/`, `android/`, bundled fonts and notices, `pubspec.yaml`, `pubspec.lock`, analysis settings, all tests/fixtures, backend source/rules/indexes/package lock, trusted issuer and Firebase-config tools, docs and final test evidence. Include `gradlew` and its checked-in wrapper configuration. There is no generated code needed for reconstruction.

Exclude `.dart_tool/`, `build/`, `node_modules/`, `.gradle/`, `android/local.properties`, `android/key.properties`, operator-specific `android/app/google-services.json` and external production definitions, signing/issuer private keys, service-account credentials, `.secret.local`, `.env*`, runtime configuration, generated `integration-test-defines.json`, diagnostic logs containing fixture tokens and any real financial data. Deliver test/release APKs separately with clear labels after successful verification. Do not remove caches while another build is using them; prepare a filtered review archive after work stops. The public test license fixture is synthetic and is never automatically trusted by application code.

Production deployment, paid billing, real user creation and legacy migration remain separately reviewed actions. Follow the concrete approval and rollback boundaries in `migration.md`; this guide does not authorize running them.

Flutter 3.47 integration tests uninstall their test application after each run by default. Native persistence/update phases MUST use `--no-uninstall`; otherwise the test harness deletes the database and Keystore identity, which is not an APK-update behavior.
