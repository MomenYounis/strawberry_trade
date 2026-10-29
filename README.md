# دفتر الفراولة — Arabic Flutter Android ledger

> تحديث ٢٣ أكتوبر ٢٠٢٦: الإصدار ٩ يضيف دعوة موظف لمرة واحدة دون UID، وإنشاء حساب الموظف وتأكيد بريده من الهاتف. نُشر تحديث البوابة الموافق عليه؛ APK الجديد يُثبت كتحديث على هاتفَي المدير والموظف. ابدأ من [دليل الإصدار ٩](docs/employee-invitations-v9-ar.md) و[الحالة الحالية](docs/current-status-ar.md). التقارير الأقدم أدناه تاريخية، ولا تمثل أحدث حالة النشر أو APK.


An independent native Flutter rebuild of the strawberry trading ledger. Arabic is the fixed default, with RTL widgets and bundled fonts. SQLite/SQLCipher is the durable working ledger; a single outbox synchronizes through tenant-scoped Firebase callable services. The legacy website is not embedded in a WebView.

**Latest status, 20 October 2026:** the owner-approved no-card Cloudflare gateway is deployed, its protected secrets and dedicated Google runtime identity are configured, and the employee index is READY. Signed APK **1.0.0+8** is installed on the owner's phone. Separately approved owner/device enrollment completed; server readback observed matching device-proof challenges and sessions. The owner reported that home opened online and reopened without login after disabling the network. Live invoice synchronization/retry, phone PDF export and update with business records remain untested. Read [the current Arabic status](docs/current-status-ar.md) first; the version-6/version-7 preparation paragraphs below are historical context.

**Local administration:** the password-protected Arabic panel is installed on this laptop at `http://127.0.0.1:8765`. It reuses the existing operator login; compatible gateway deletion protection is deployed. Local emulator CRUD checks and live read-only display checks passed; no real tenant was created or deleted for GUI testing.

**Review status:** implemented source and automated tests are provided; broader production distribution still requires the remaining business-operation checks. The route uses Firebase Spark plus Cloudflare Workers Free with one SQLite Durable Object, without a payment card or Blaze. Exact local, cloud and phone results are separated in [the test report](docs/test-results.md). Historical version 7 has verified Firebase Android configuration, a separate release/issuer identity, registered certificate fingerprints and a signed setup APK; its packaging evidence is in [the setup report](verification/firebase-connection/setup-artifacts.json). That APK predates external-URL routing and does not inherit version-8 acceptance. Earlier version-6 debug/unsigned artifacts and emulator acceptance remain separate historical evidence.

## Start here

- [Local Arabic admin panel](tools/admin-panel/README.md): laptop-only GUI for tenants, manager accounts/devices, paid activation and confirmed permanent tenant deletion; [Arabic user guide](docs/admin-panel-ar.md).
- [Current operating status](docs/current-status-ar.md): deployed endpoint, signed v8, credential custody and exact remaining phone/onboarding steps.
- [No-card setup](docs/no-card-setup-ar.md): the required free-hosting route, current verification and remaining account/deployment steps.
- [Current deployment review](docs/deployment-review-no-card-ar.md): fresh local checks, read-only Firebase findings, missing employee index and the remaining account/approval steps.
- [Trusted owner onboarding tools](tools/production-operator/README.md): a plan-only default and a separate opt-in application module, locally verified by 30 tests. Every application requires the owner's approval of the exact account, tenant, phone key, session revocation and one-time trial; the first approved owner enrollment completed on 20 October.
- [Arabic end-user guide](docs/user-guide-ar.md): offline work, employee invitations, activation transfer and recovery.
- [Arabic production setup](docs/production-setup-ar.md): existing project, exact owner/developer actions, local key custody and APK distinctions.
- [Developer guide](docs/developer-guide.md): architecture, toolchain, tests, Android build and signing.
- [Backend/API and cost estimate](docs/backend.md): local emulators, trusted services and the separate hosting options.
- [License issuer and device lifecycle](docs/licensing.md): separate trusted tool, key handling and limitations.
- [Security assessment](docs/security.md), [safe migration](docs/migration.md), [legacy function map](docs/feature-map.md).

## Local review

Use Flutter **3.47.2**, Dart **3.13.2**, Java **17** and Node **22**. Dependencies and lockfiles are pinned. These commands run from the Flutter project root unless stated otherwise:

```sh
flutter pub get
flutter analyze
flutter test
```

Run backend checks from `backend/`:

```sh
npm ci
npm test
npm run test:integration
```

The integration command starts/stops local Firebase services and clears the demo project's Firestore fixtures. For Android review, start `npm run emulators` in `backend/`, leave it running, then in another terminal:

```sh
flutter build apk --debug --dart-define-from-file=integration-test-defines.json
```

The wrapper creates the public-only definitions file for its current ephemeral issuer. The Android emulator uses host `10.0.2.2`, Firebase project `demo-strawberry-flutter` and region `europe-west1`. A trusted local seed helper enrolls synthetic Android fixtures. No production accounts or data are needed. Follow the [developer guide's Android driver sequence](docs/developer-guide.md#android-emulator-development) for the gateway test: its PDF chooser must be dismissed and the network disabled at the fixture marker. All persistence/recovery commands use `--no-uninstall`; preserve the matching public definitions before restarting an issuer. The guide also covers physical-device forwarding and update tests.

## Implemented behavior and boundaries

Native entry, sales/purchases, collections/payments, categorized expenses, returns, parties/opening balances, debt adjustments, effective-dated payroll, employee requests/review, statements, PDF/CSV, licensing and scoped backup/restore have replacements. Financial corrections append documented reversals, preserving history. Local save, server acceptance and manager approval are distinct states. A disconnection or expired license preserves the ledger and outbox.

Native reports also include monthly financial bars, expense-category comparisons, editable operating/home budget targets and an explicitly estimated current-month forecast. Post-entry shipment changes append ordered audit events without modifying invoice financial facts. Arabic statement text can be copied for manual sharing.

Intentional differences are explicit in the function map. Employee submissions use a deliberately limited quantity-only role projection; legacy employee own-purchase pricing is not exposed. Accounts must exist and have verified ownership before invitation; the manager app does not create real Auth users or send password-reset emails. QR scanning is not included; signed activation files and pasted packages provide offline transfer.

The project does not implement inventory, physical cash reconciliation, multiple cashboxes or employee cash custody. Reports use accurate labels: sales minus purchases is not actual profit, and recorded net cash movement is not cash on hand.

## Source layout

`lib/domain/` contains pure Dart accounting and validation; `lib/data/` owns the schema-versioned store; `lib/application/` coordinates sessions/sync; `lib/presentation/` provides Arabic native screens; `lib/security/` owns licensing/time/device contracts; `lib/services/` handles callable transport and exports. `android/` contains the Android project and Keystore integration. `test/` and `integration_test/` separate host tests from native acceptance. `backend/` and `tools/license-issuer/` are trusted Node tools, never client dependencies. No code generation is used.

The earlier source and production database remain unchanged. No deployment, production migration, billing upgrade or real account creation is performed by opening or building this project. Private issuer keys, APK signing keys, service-account credentials, `.secret.local`, build caches and generated session definitions must not be committed or included in a source-review archive.
