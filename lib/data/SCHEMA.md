# Durable ledger contract

`LedgerStore.open` binds one SQLCipher database to one tenant, Firebase UID,
role and employee identifier. The scope row is checked every time it opens.
Use a filename derived from an unambiguous encoded scope, and obtain its random
password from `DeviceSecurity.databasePassword` using the same scope. A database
does not confer membership or licensing authority; the application verifies its
issuer-signed membership separately before opening an operational session.

Android uses `sqflite_sqlcipher` and rejects a missing/short password or an
unavailable `PRAGMA cipher_version`. Only host tests inject
`databaseFactoryFfi`; those temporary files are ordinary, unencrypted SQLite.
The Android integration test verifies encrypted bytes and rejection of a wrong
key. It must be executed on Android before claiming those paths were verified.

## Tables and relationships

Schema version 1 defines `scope`, `parties`, `employees`, `salary_terms`,
`entries`, `submissions`, `outbox`, `drafts`, `preferences` and `audit`.
`entries.party_id`, `entries.employee_id`, `entries.original_id` and
`salary_terms.employee_id` have SQLite foreign keys. Salary terms have a unique
employee/effective-month constraint. Indices cover date/ID ordering, party/date,
original-invoice references, salary history, party names and submission creator.
Employee submission identity comes from the verified session; employee stores
do not download the manager's employee/payroll tables.

Version 2 adds `outbox.next_attempt_ms`, the queue schedule index and `conflicts`.
The upgrade is an in-place SQLite transaction. The real disk test reconstructs
a version-1 database with committed entries and a retried outbox operation,
opens it at version 2, and checks that identifiers and attempts survive.

Financial rows and their operation ID are immutable. Recording a row, its outbox
message, its audit event and deleting its completed draft occur in one SQLite
transaction. A failing queue insert aborts the row and audit insert as well;
the draft remains. Reusing the same ID with identical facts is idempotent.
Changing financial facts under that ID is rejected. Corrections use a reasoned
reversal; original facts and audit evidence remain.

## Numeric and accounting policy

All values are Dart integers: currency is 1/100 EGP, quantity is 1/1000 of the
explicit invoice unit. Unit prices also have 2 decimal places. Totals use positive
half-up rounding of `qtyMilli * priceMinor / 1000`, with bounds that keep the
intermediate product within JavaScript's exact integer range for the gateway.
Input accepts Western, Arabic-Indic and Persian digits and a decimal dot,
Arabic decimal separator or comma. Thousands separators are rejected to avoid
ambiguous interpretation. Unsupported precision is rejected, not silently
rounded. Untrusted decimal digits are scaled using `BigInt` and checked against
the supported amount bound before conversion to a native integer, so a large
input cannot wrap into a small accepted value. Legacy 4-decimal prices or greater quantity precision require a
remediation report during migration.

A partial return uses cumulative rounded returned value minus already-returned
value; the final return consumes the exact remaining invoice value. Returns
must match invoice, tenant, party, grade, unit and price. Both quantity and value
are bounded cumulatively. An invoice with active returns cannot be reversed.
The gateway must repeat these checks atomically across devices; local acceptance
before that check remains provisional.

Party opening balances are signed. Collection/payment amounts reduce the
corresponding receivable/payable. A return reduces debt by its value minus the
cash refund. Statements include prior activity in their starting running balance
when a date filter is used, including periods containing no activity. A reversal
takes effect on its recorded date and does not rewrite earlier period totals.
`balance_adjustment` records a positive `totalMinor`, zero cash and quantity,
an explicit `adjustmentDirection` (`increase` or `decrease`), the existing party
and a mandatory reason. It changes that party's receivable/payable only and is
immutable; correcting it requires a separate reversal. Payroll is a distinct operation with a recipient and
salary month; an operating expense creator is never treated as its payroll
recipient. Effective-dated salary terms preserve history. Missing historical
entitlement returns `null`, not an invented current salary.

Shipping changes use immutable `shipment_update` ledger events with an active
original invoice, zero financial amounts and quantity, an optional active
shipping employee, shipment reference, required status and documented reason.
They never rewrite the invoice. `shipmentOrder` is positive only on these events;
other entry kinds use zero. The gateway advances a trusted per-invoice counter
atomically and rejects a competing order as a conflict. A correction uses a new
event and ID; shipment events cannot be reversed. Projections use this order,
exclude rejected/conflicted messages and flag ambiguous provisional events.
These payload fields require no SQL schema migration.

`netRecordedCash` is recorded inflows less recorded outflows. Its optional date
range must be applied to the complete ledger so a reversal can offset an older
original transaction. It is not a
reconciled cashbox or actual profit. This implementation does not add inventory.

## Queue, conflicts and synchronization

The local outbox is the only submission queue. The Firebase gateway is a
callable HTTPS operation coordinator rather than Firestore SDK writes. Each
retry reuses `{id, entity, payload, expectedRevision: 0}`. A local commit,
server acceptance and employee review are distinct states. Authorization and
license failures retain the message. Retry delays and attempt counts survive
restarts. `revokeAccess()` immediately invalidates stale store handles, including
private reads and synchronization callbacks. Guarded transactions check again
before commit so an operation racing revocation rolls back. The handle cannot
be reauthorized; trusted reauthentication opens a new handle over the preserved
database. Closing a store invalidates callbacks; acknowledgments additionally
check the captured tenant/UID. A new account uses a new store.

Trusted remote pages use `applyRemoteBatch` with `{entity, payload}` changes and
a maximum of 1,000 events (normal gateway pages contain at most 500). One guarded
transaction loads the entry, party, employee and salary projections once, then
extends those projections as each event validates. Later events can therefore
refer to earlier rows in the same page, and cumulative returns see all preceding
accepted quantities. Invalid data or revocation before commit rolls back the
whole page and its audit writes. A successful page emits one change notification.
The existing `applyRemote` method delegates to a one-event batch. Cursor updates
follow successful page commits; replay after interruption still uses immutable
IDs and canonical comparison, retaining explicit conflicts rather than replacing
existing financial facts.

An employee approval is queued provisionally and creates no financial entry
until the gateway returns its atomically accepted canonical entry. Both remote
submission states and review events update the local review display. Server
metadata is normalized separately from immutable submitted facts; map key
ordering does not create a conflict.

Conflicting facts preserve both local and remote JSON and the reason. Explicit
manager acceptance of the server version requires a reason and validates the
complete resulting ledger, including linked returns. This choice is audited;
the old local evidence remains. A conflict lacking an authoritative remote
version remains blocked for a documented correction/review rather than being
silently deleted.

## Backups and restoration

Backups contain ledger rows, counterparties, employees, salary evidence,
submissions, drafts, conflicts, audit evidence and pending operation IDs.
They contain no device key, credentials, membership, entitlement or activation
setting. Export is manager-only. Exported JSON contains private financial data
and must be handled as sensitive; database encryption does not encrypt a shared
JSON export.

Import requires the currently enrolled manager's identical tenant and UID.
Trusted enrollment and a new issuer-signed device package are still required
on another phone. Validation checks every amount, relationship, duplicate ID,
return, queue payload and scope before an atomic merge; authority-like top-level
fields are rejected. Existing nonidentical immutable facts abort the merge.
Imported audit is evidence, never authorization. Restored server status is
provisional until a trusted matching snapshot confirms it. Existing queue IDs
remain unchanged, so duplicate delivery to the same server stays idempotent.

## Verification commands

```sh
flutter test test/domain_test.dart test/store_test.dart
flutter test test/preference_backup_test.dart test/scale_storage_test.dart
flutter test test/widget_test.dart
flutter test integration_test/local_persistence_test.dart -d ANDROID_DEVICE
flutter test integration_test/native_full_storage_test.dart -d ANDROID_DEVICE --no-uninstall
flutter test integration_test/local_persistence_test.dart -d ANDROID_DEVICE --no-uninstall --dart-define=PERSISTENCE_PHASE=seed
# Install a newer APK with the same application ID and signing key using -r.
# Do not uninstall or clear data between phases.
flutter test integration_test/local_persistence_test.dart -d ANDROID_DEVICE --no-uninstall --dart-define=PERSISTENCE_PHASE=verify
```

The seed/verify fixture intentionally retains its retried operation (including
attempt count and next-attempt time), incomplete Arabic numeric draft and secure
device/key marker. A separate native SQLCipher test reconstructs a version-1
database and checks its in-place migration. Ordinary round-trip and migration
fixtures are removed when their tests complete.

`native_full_storage_test.dart` uses the actual Android Keystore channel and
native SQLCipher plugin, without replacing reads, writes or exceptions. It sets
a page-count limit on an isolated encrypted test database and provokes native
`SQLITE_FULL` (13), then checks rollback of the financial entry, outbox and audit,
retention of an Arabic draft across close/reopen, and idempotent retry after
raising the fixture's page limit. This is a bounded SQLCipher pager-exhaustion
test; it does not fill the phone's filesystem and does not establish behavior
under operating-system-wide low storage. Host scale timings likewise describe
real SQLite FFI on the development computer, not Android performance.

The observed Android plugin path can mask a transaction's full-storage error:
SQLite automatically rolls back on `SQLITE_FULL`, then the plugin issues a second
`ROLLBACK`, whose `cannot rollback - no transaction is active` error has code 1.
The native test first requires code 13 from a direct pressure insert and then
accepts either transaction code 13 or that exact secondary rollback error. It
still requires no partial ledger, outbox or audit write, an intact saved draft,
successful close/reopen, and a same-ID retry after raising the page budget.
Verification metrics report the capacity code and transaction exception code
separately; code 1 is never described as a returned `SQLITE_FULL` code.
