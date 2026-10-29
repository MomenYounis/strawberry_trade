# Implementation plan and boundaries

1. Inspect legacy source and rerun its tests in an isolated copy. Record the feature inventory and independent reference values.
2. Prove the vertical path first: transactionally persist a ledger entry and outbox in SQLite, reopen from disk, send one stable identifier through an emulator-only gateway, obtain server acknowledgment, and create an Arabic PDF from bundled fonts.
3. Establish tenant authorization, device proof, signed entitlement/membership, trusted trial time and a Keystore identity. No untrusted local role or activation flags.
4. Build Arabic RTL Flutter screens over local repositories: entry, directories, review, returns, payroll, statements, reports, synchronization, activation, backup and restore.
5. Exercise domain, real SQLite, widget, gateway/rules and Android acceptance paths. Fix defects and record precise remaining gaps.
6. Produce debug test APK and a release build only with appropriate external signing configuration. Preserve the original source, production database, Firebase project settings and signing material.

Architecture: Riverpod provides application session state and dependency injection. Business calculations are plain Dart; LedgerStore is the SQLite repository; a single callable gateway coordinator owns delivery and server acknowledgments. No Firestore client write queue is used. Flutter widgets are the primary UI; no WebView or old accounting runtime is included.

Default environment is demo-strawberry-flutter emulators. Real Firebase registration/configuration and all deployments are separately reviewed actions. The Android package is com.strawberrytrade.strawberry_trade and must remain stable for updates.
