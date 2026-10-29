# Build an Arabic, Offline-First Strawberry Trading App with Flutter for Android

Rebuild my existing project as a Flutter application written in Dart, targeting Android and suitable for distribution to independent trading businesses as an APK. The application must be offline first. Flutter is an explicit requirement for this version. Carry the work through to an implemented, tested, reviewable deliverable; do not stop at a plan or display the existing website inside a WebView.

**Language requirement: this implementation prompt is in English, but the application must be in Arabic.** Arabic must be the default application language, including when the device language is English. All user-facing screens, navigation, forms, validation messages, notifications, licensing and activation screens, synchronization states, reports, account statements, and PDF documents must use clear Arabic. Support right-to-left layout throughout, with correct handling of mixed Arabic and Latin content such as email addresses, device identifiers, activation codes, and numbers. Code identifiers and developer documentation may be in English. Keep end-user instructions in Arabic. Do not turn this into an English-language application because the implementation instructions are written in English.

## Project and scope

Source project:
`/home/younis/Documents/Codex/2026-10-17/new-chat-2/outputs/strawberry-trade-firebase/strawberry-trade`

Also read the English project review:
`/home/younis/Documents/Codex/2026-10-18/i/outputs/mobile-migration-review-en.md`

This is a standalone Flutter implementation request. Use the review's functional and security findings, but its Capacitor recommendation is superseded by the explicit Flutter requirement in this prompt. Do not modify the earlier prompt files.

Inspect the actual project files and verify the findings yourself. The review is a starting point, not a substitute for understanding the implementation. Follow any applicable AGENTS.md instructions. Work in a separate copy that preserves the source and its data. Do not modify production data, deploy rules, or migrate production records while experimenting. Prepare deployments and migrations for review first. Do not enable billing, spend money, or create real user accounts without my approval of the concrete action.

Android is the initial target. Do not add iOS, a complete inventory system, or marketing services to this migration. Use the existing project to understand its behavior, data models, and calculations. Reuse valid Firebase configuration, rules, and backend services after fixing them as needed. Rebuild the interface and client-side logic in Dart while preserving sales, purchases, collections and payments, expenses, returns, payroll, counterparty accounts, account statements, PDFs, employee management, employee submission review, backups, and restoration. Create a feature map showing every existing function, its Flutter replacement, and how you verified it. Do not reproduce known bugs merely to match legacy behavior.

## 1. Required technology and architecture: Flutter and Dart

The current application is a vanilla HTML/JavaScript PWA. Its `build.mjs` generates `web/index.html` from `source/manager.html`. Create an independent Flutter project using a compatible stable Flutter release and Dart with sound null safety. Use Flutter widgets for the application's primary interface. Do not use Capacitor, Ionic, React Native, or a WebView to implement the ledger screens or run the old accounting engine. Do not make a browser or JavaScript runtime the core of the application.

Separate presentation and state management from business logic and data sources. Put calculations, financial validation, and ledger models in testable Dart units. Provide repositories with clear interfaces for local data and synchronization. Choose one suitable state management approach, such as Riverpod or Bloc, and briefly explain the choice. Avoid architectural complexity that does not serve the project's actual size.

Use SQLite as the primary local database, through an appropriate layer such as Drift or sqflite after checking its documentation and compatibility. Explicitly define tables, relationships, indexes, schema versions, and migrations. Save a business operation and its outbox entry in a single database transaction. Do not store the ledger or operation queue in SharedPreferences. Specify how the database and its keys are protected, and verify on Android that the chosen libraries actually support the encryption mechanism you claim to use.

Use FlutterFire for the required Firebase services, with an Android app registration and an appropriate package name. Never put the Admin SDK in the client. Keep necessary backend and rules fixes within scope, and separate development, test, and production environments. Prepare Firebase integration against the test environment and emulators; changes to the actual production project remain subject to the deployment boundaries above.

Port correct JavaScript behavior to Dart using shared reference cases with known numerical results. The web code cannot be directly reused as Flutter UI. Its primary value is the existing feature definitions, contracts, data, and tests, together with backend services that remain valid after review.

Before expanding implementation, prove a small end-to-end path: open the ledger locally, save an operation and its outbox entry, close and reopen the app offline, synchronize that operation exactly once with the Firebase emulator, and generate and share an Arabic PDF. Use this to validate the architecture and library choices, then complete all features.

Pin dependency versions and include the lockfile. Consult current official documentation for libraries, Android, and Firebase. Do not make essential application behavior depend on a CDN or a remotely loaded page. Package the interface and essential assets with the app.

Official starting references: [Flutter offline-first architecture](https://docs.flutter.dev/app-architecture/design-patterns/offline-first), [Firebase for Flutter](https://firebase.google.com/docs/flutter/setup), and [Android build and release](https://docs.flutter.dev/deployment/android). These references establish the approach and integration options; they do not replace checking the specific packages you choose.

## 2. Offline operation is the default

Assume the devices will be offline most of the time. After a trusted initial online setup of the account, device, and business membership, the app must open, display available data, accept authorized operations, and calculate statements and reports locally without a server request for every operation or every launch. Do not add mandatory daily online verification that defeats this requirement.

Make SQLite the durable working data source on the device. The Flutter interface reads the ledger from the local layer and observes its changes, rather than waiting for the network to display the ledger or confirm that an operation has been recorded. Save the operation and the information needed to send it in a single local transaction. Protect data and keys appropriately, using Android Keystore where applicable. Do not rely on SharedPreferences or the Firestore cache alone as a long-term ledger.

Assign each operation one stable identifier when it is first created. Keep that identifier across app restarts and retries. Synchronization must tolerate retries, duplicate delivery, and out-of-order arrival without duplicating financial effects. Maintain a durable queue, suitable retry behavior, and explicit states. Never discard an operation because of a disconnection, authorization failure, license expiration, sign-out, or application update.

Define the relationship between the local outbox and any internal Firestore SDK write queue. Use one coordinator for the send-and-acknowledgment lifecycle. Do not create independent submission paths that duplicate operations or disagree about their state. Final acknowledgment requires confirmation that the server accepted the operation, not merely a local snapshot or a pending SDK write. Prevent a late acknowledgment from an old session from changing the state of a different user or business.

Attempt synchronization on launch, on return to the foreground, and when usable connectivity becomes available. Include a manual sync action. Appropriate Android background work may be added, but do not depend on a Dart timer or promise that the process remains alive after a force-stop. Design the queue to resume safely at the next actual execution opportunity. Distinguish the presence of a network from the ability to reach the server. Refresh Firebase authentication when connected without allowing access-token expiration to erase the ledger or interrupt local recording that is permitted by the stored membership and license policy.

Show a successful save only after the local transaction commits. Storage failures or a full device must preserve the form's data. Prevent repeated taps from creating duplicate operations. Local persistence, server acceptance, and manager approval are separate states.

When two devices conflict, preserve both changes and the conflict reason, and provide an explicit resolution process. Never silently replace financial amounts or invoices. Operations requiring a global invariant, such as approving one submission or checking cumulative returns, must undergo atomic validation when synchronized. If a local action is allowed before that validation, show its provisional status. Do not promise global consistency that cannot be guaranteed without connectivity. Changes from another device cannot arrive while disconnected; show the last successful synchronization time.

Switching users or businesses must not mix their data or send one account's queue under another account. Database migrations during APK updates must preserve records and pending operations.

## 3. Isolate independent businesses within one Firebase project

Redesign the system around independent businesses, or tenants, using paths such as `/tenants/{tenantId}/...`. Each tenant has its own owner/manager, employees, ledger, and license. All data types, including directories, submissions, reviews, account links, audit history, and attachments if present, must belong to a tenant.

Membership and ownership must come from a trusted authority. A client-supplied `tenantId` or role is not evidence of authorization. Prevent unauthorized ownership changes, self-promotion, creation of platform administrators, employee impersonation, and movement of records between tenants. Enforce the boundaries in rules, every endpoint, and every Admin SDK service. Admin SDK services bypass Firestore rules and therefore require their own authorization checks.

Separate the product owner's license-issuing role from the business manager's operational role. Do not give the trading application platform-administration privileges. Employees must never receive pricing, profit, balance, or payroll data that their role is not permitted to access, including through caches, backups, or reports.

Prepare a safe migration of the existing ledger into one tenant: a backup, a dry run, preservation of identifiers, relationships and balances, before-and-after validation, closure of the old shared paths, and a rollback plan. Do not run the production migration automatically.

## 4. Free trial and device-linked activation

Provide one 30-day free trial per tenant. Its start must be established using trusted server time at the first valid setup, with a fixed expiration exactly 30 × 24 hours later. All employees inherit the same entitlement and expiration. A new employee does not receive a fresh 30-day trial.

Provide a simple Arabic licensing screen showing the remaining trial period, activation status, and device identifier, with actions to copy the device identifier, copy an activation request, and enter or paste an activation code. I want the business owner to copy the identifier and send it to me outside the app; I will send back the appropriate activation code. Do not automatically send messages on my behalf.

Bind the activation request to the tenant and the device, using an installation identity with appropriate protection. Do not request the IMEI or assume an installation identifier survives uninstalling the app. A device-protected key pair and an identifier derived from its public key are possible options. The identifier is not a password and must not independently grant access.

For Flutter, verify the actual capabilities of the chosen secure-storage and cryptography packages. Do not assume every stored key is non-exportable. If the design requires generating and using a device key inside Android Keystore, use an integration that actually supports that operation or a small Kotlin implementation through platform channels, without exporting the private key into Dart. License signature verification can use a reviewed cryptographic library and the issuer's public key.

Handle loss of the device key or restoration of the database onto a different phone through a trusted re-enrollment and license-reissue flow. Do not assume a database backup transfers Keystore keys. This flow must not restart the trial or grant an entitlement the tenant did not have. Keep the APK signing key, the license issuer's signing key, and device keys separate; do not reuse one key for these different purposes.

Because the application will usually be offline, licenses must be locally verifiable using asymmetric digital signatures. The private license-issuing key must never be included in the APK, public web assets, or client repository. Deliver a separate trusted tool for me to issue activation codes or license packages, with instructions for securely storing, backing up, and rotating the signing key. Do not put a shared signing secret in the application or rely on an editable local `isActivated` flag.

Define the license package fields and how you prevent a package from being used for the wrong tenant or device. Re-entering the same package must not duplicate or improperly extend its entitlement. A paid license may be perpetual or have an expiration date selected by the product owner at issuance. Do not invent pricing or a renewal policy I have not specified. Make the number of authorized manager/business devices configurable, with a trusted device-transfer process that does not restart the trial.

The tenant entitlement is authoritative: activating the manager's business also activates its linked employees; expiration of the business trial stops operational use for both the manager and employees. Employee membership and authorization certificates must be trustworthy. A manager must not be able to generate a new signature that extends their business entitlement. Disabling an individual employee remains a separate control.

Update licenses when connectivity is available. To activate employee devices that will remain offline, support importing an issuer-signed transferable package through a file or a QR code where size permits, while validating membership and device binding. The manager may transfer an authentic package but must not be able to invent a new entitlement. Explain the practical steps end users will follow.

Clearly distinguish a previously known expiration that can be checked locally from a new revocation, renewal, or permission change that cannot reach a disconnected device until it reconnects or receives authenticated transferred information. Do not promise instant centralized shutdown while devices remain offline for long periods. Do not undermine the offline-first requirement by imposing a short verification lease without my agreement.

Protect license time checks using trusted reference time, the last accepted time, and monotonic time where available. Test clock rollback, device restarts, timezone changes, reinstallation, and device changes. Document the limits on compromised devices or modified applications; do not claim absolute offline tamper resistance. A server-recorded trial prevents reinstalling from restarting the same tenant's trial, but a new account alone does not prove a different real person.

When the trial expires, lock operational features and show activation options. Preserve the ledger, outbox, and safe recovery options without exposing data to an unauthorized role. Define an explicit policy for pending operations that did not reach the server before expiration. Do not accept a client device timestamp as trusted proof for bypassing server-side license expiration. After renewal, resume the saved operations without duplicating their effects.

## 5. Verified issues to reproduce and resolve

- Shared global paths and missing tenant isolation in `backend/firestore.rules`. Do not add a second independent business to the same unscoped paths.
- Promotion of an existing account with an unverified email in `backend/scripts/provision-member.mjs:124–135`. Address account ownership verification, invitations, and prior sessions. Checking an email string in the client is insufficient.
- Manager forms ignoring the return value of `saveState()`, and allowing writes before the local ledger is ready: see `web/cloud.js:41`, `web/sync.js:17`, and `source/manager.html:3219`. Review all similar forms.
- Backup import accepting inconsistent invoice totals and payments, and returns with a different unit or grade from the original invoice: see `source/manager.html:1742–1755`.
- Rules for manager records validating only a generic document shape, without enforcing financial invariants or mandatory audit history.
- Employee review screens omitting the merchant/customer or supplier name: see `web/cloud.js:55–56` and `web/core.js:39`.
- Rapid taps creating duplicate employee submissions even though network retries reuse a stable identifier.
- Historical payroll balances using the employee's current salary: see `source/manager.html:2482–2488`. Store effective-dated salary terms or a fixed monthly entitlement. Do not invent missing historical salaries during migration; preserve available evidence and request clarification only for genuinely ambiguous cases.

## 6. Validate accounting and functional correctness

Separate calculations into testable units. Enforce the same invariants during entry, editing, import, approval, synchronization, and trusted backend validation. Standardize currency representation, weight precision, and rounding. Reject NaN, Infinity, and negative values where the operation does not permit them.

Review partial and full sales and purchases, customer collections, supplier payments, opening balances, expenses, payroll and installment payments, partial/multiple/full returns, cash refunds, and debt adjustments. Do not allow cumulative return quantities or values to exceed the available original amount. A return must match the original counterparty, grade, unit, and invoice. Do not change an original invoice in a way that invalidates approved returns without a correct accounting adjustment.

Preserve exactly-once approval effects, creator attribution, and the distinction between an operating expense recorded by an employee and that employee's payroll or cash advance. Correct posted operations through documented voids/reversals or another mechanism that preserves financial effects and audit history. Review dates, filters, running balances in statements, PDF and CSV output, backups, restoration, and relationships between records.

Do not call sales minus purchases actual profit without accounting for inventory costs. Do not call net recorded cash movement actual cash on hand without opening cash, owner funding, withdrawals, and reconciliations. Use accurate labels for existing features. Treat inventory, employee cash custody, and multiple cashboxes as separate additions if they are not implemented within the agreed scope.

## 7. Make daily mobile work easy

- A clear Arabic RTL interface, large touch targets, readable text, and uncluttered navigation, usable on small screens and mid-range or lower-end devices.
- Fast entry for sales, purchases, collections/payments, expenses, and returns, with counterparty search, favorites, and recent selections.
- Save-and-add-another, copying an operation into a new draft with a new identifier, and remembering grade, unit, and preferences per user and tenant. Do not automatically copy quantity and paid amounts into a newly approved operation.
- Support Arabic-Indic and Western digits, appropriate decimal separators, errors next to the relevant field, protection against repeated taps, and drafts that survive interruptions.
- Understandable Arabic states for local saving, synchronization, and approval, with a page for pending/conflicting operations, retry attempts, errors, and the last successful synchronization time.
- Manager review screens that show the counterparty, quantities, original invoice, and financial impact before approval. Employee screens show only what the employee is authorized to see.
- Correct handling of Android back navigation, keyboard appearance, system insets, locking and unlocking, background/foreground transitions, and rotation without losing input.
- Android file saving/sharing for PDFs and backups, with Arabic typography and long-page testing. History and search must allow access to authorized older records rather than ending at the latest 50 entries with no way to browse further.

Use Flutter's localization and RTL capabilities, and bundle the required Arabic fonts. User-facing application text must be Arabic even when technical identifiers or underlying error codes are English; map those codes to useful Arabic messages. Keep emails, device IDs, activation codes, and other inherently Latin strings legible with appropriate directionality. Build PDF generation, exporting, and sharing in Dart/Android. Do not assume existing DOM-, canvas-, or browser-download-based code works in Flutter. Test PDFs in airplane mode, including text direction, Arabic shaping, numbers, line wrapping, pagination, and file sharing with appropriate Android permissions.

## 8. Security review

Perform an actual threat assessment and use deny-by-default rules. Cover authentication and membership, tenant isolation, privilege escalation, forged counterparty/employee identifiers, license and timestamp manipulation, leakage through caches/backups/reports/logs, SQL injection, imported data and file handling, platform channels, native components, app links, and Android system backups. Also review XSS and web security in any administrative tools or legacy web surfaces that remain part of the product.

Never embed service-account keys, private license-issuing keys, or Admin credentials in the client. Validate string lengths, array sizes, nested fields, and data types. Add appropriate per-tenant abuse controls to connected services. Do not log passwords, activation codes, or financial records in crash logs.

Use App Check/attestation as an additional layer if appropriate for direct APK distribution, after testing the actual configuration. Never ship debug tokens in the distribution build. Attestation is not a substitute for authorization and must not require connectivity merely to record an authorized local operation.

Do not claim that hiding a button protects a function, or that database encryption prevents all tampering on a compromised phone. Report remaining weaknesses, severity, evidence, and mitigation limits without promising that there are no vulnerabilities.

## 9. Acceptance testing and delivery

Rerun the existing tests, then add tests that reproduce the issues above and demonstrate their fixes. The prior review recorded 30 passing client tests and 42 passing rules tests. These do not cover every manager screen, Android behavior, or complete accounting correctness. Do not treat those counts as a guarantee or claim they still pass without rerunning them.

Run the legacy web tests as a baseline for understanding correct behavior. Add independent Dart tests for calculations, invariants, and licensing; actual SQLite tests for transactions, migrations, and the outbox; widget tests for forms, save states, and authorization; and Android integration tests using Firebase emulators. Merely copying JavaScript test names is insufficient. Do not use mocks alone to prove the layer that must persist on disk. Compare correct reference results between implementations, and include examples that demonstrate intentional behavior changes when fixing legacy bugs.

Verify at least the following with Firebase emulators, synthetic data, and Android devices/emulators:

1. Two tenants with separate managers and employees. All cross-tenant reads, writes, imports, exports, and synchronization attempts are denied, including guessed IDs and substituted submission identifiers.
2. A 30-day trial; an employee joining on day 29; exact expiration boundaries; manager activation; inherited employee entitlement; offline license-package transfer; incorrect, modified, or wrong-device codes; clock changes; reinstallation; and device replacement.
3. Airplane-mode operation, force-closing immediately after a local save, closing before and after transmission, restarting the device, and updating the APK. Every committed operation survives without loss or duplication.
4. Interrupted synchronization, duplicate transmission, out-of-order delivery, concurrent edits from two devices, duplicate approval, and two returns whose combined quantity exceeds the original invoice.
5. Full storage or failed local transactions, cold starts before ledger readiness, and rapid repeated save taps. No false success messages and no lost draft.
6. A reference ledger with known results for sales, purchases, balances, payments, returns, payroll, and rounding. Screen totals, account statements, PDFs, and restored backups agree.
7. Restoration onto a different device, retaining queued operation identifiers without duplicating effects, and ensuring that a backup cannot re-grant revoked authority.
8. Realistic multi-season data volumes, search, lists, statements, initial synchronization, and incremental synchronization, without downloading manager-only information to employees.

Also verify Arabic on a device configured in English: default Arabic screens and messages, correct RTL and mixed-direction fields, Arabic PDF output, and Arabic validation/synchronization/license errors. Raw English SDK errors must not become the normal end-user experience.

Deliver the full Flutter project, including Dart sources, the Android directory, `pubspec.yaml`, `pubspec.lock`, code-generation configuration, database migrations, and tests. Provide a test APK and a signed release APK when secure release-signing configuration is available. If a release key is unavailable, do not present a debug APK as a production distribution build. Prepare everything that can be built and state the specific signing requirement, without committing private keys to the repository. Preserve a stable package name and signing identity so future updates retain data.

Verify Dart formatting, static analysis, tests, and an actual build. Record the Flutter, Dart, Java, and Android SDK versions and reproducible build commands in the developer guide. Install and open the generated APK, then test updating over an earlier build containing data and pending operations. A successful debug build does not prove release-build or signing success. Precisely identify any verification that could not be performed and why.

Also deliver the private license-issuing tool and its guide; Arabic end-user instructions for offline operation, employee enrollment, activation transfer, and backup restoration; the Firebase migration plan; actual test results; the security findings, fixes, and limitations; and an estimate of paid Firebase services before enabling any of them. Deploying Cloud Functions requires the Blaze plan; do not upgrade the plan automatically.

Start by understanding the project and writing a short implementation plan. Validate tenant isolation, local persistence, and licensing through early tests, then implement incrementally. Make routine implementation decisions and keep progressing without repeatedly asking permission. Ask only about a genuine unresolved business decision or blocker that cannot reasonably be inferred, while continuing independent work. Do not consider the task complete until critical issues are resolved and the acceptance paths have been demonstrated. Never claim a test, build, or deployment happened when it did not.