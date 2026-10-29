import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common/sqflite_logger.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/licensing.dart';

import 'domain_test.dart' as reference;

Map<String, dynamic> change(String entity, Map<String, dynamic> payload) => {
  'entity': entity,
  'payload': payload,
};

void main() {
  setUpAll(sqfliteFfiInit);

  test('A remote page validates dependencies from earlier events and notifies once after commit', () async {
    final dir = await Directory.systemTemp.createTemp('remote_page_');
    final store = await LedgerStore.open(
      path: '${dir.path}/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    var notifications = 0;
    final subscription = store.changes.listen((_) => notifications++);
    final invoice = reference.invoice();
    final returned = reference.returned(invoice, 'page_return', 1000, [
      invoice,
    ]);
    const submission = EmployeeSubmission(
      id: 'page_submission',
      tenantId: 't1',
      creatorUid: 'staff',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-03',
      amountMinor: 500,
      category: 'وقود',
    );
    try {
      await store.applyRemoteBatch([
        change('party', reference.merchant.toJson()),
        change('employee', reference.employee.toJson()),
        change('salary_term', reference.october.toJson()),
        change('entry', invoice.toJson()),
        change('entry', returned.toJson()),
        change(
          'entry',
          reference
              .payment(
                'page_payroll',
                'payroll',
                1000,
                employeeId: 'e1',
                salaryMonth: '2026-10',
              )
              .toJson(),
        ),
        change('submission', {...submission.toJson(), 'status': 'pending'}),
        change('review', {
          'id': 'page_review',
          'tenantId': 't1',
          'submissionId': submission.id,
          'decision': 'approved',
          'note': 'قرار الخادم',
        }),
      ]);
      await Future<void>.delayed(Duration.zero);
      expect(notifications, 1);
      expect((await store.listEntries()).length, 3);
      expect((await store.listSalaryTerms()).single.id, reference.october.id);
      expect((await store.listSubmissions()).single['state'], 'approved');
      expect(await store.listOutbox(), isEmpty);
      expect((await store.exportBackup())['audit'], hasLength(8));
      await store.applyRemoteBatch([]);
      await Future<void>.delayed(Duration.zero);
      expect(notifications, 1);
    } finally {
      await subscription.cancel();
      await store.close();
      await dir.delete(recursive: true);
    }
  });

  test('Invalid last event or cross-tenant event rolls back the entire page and its audit', () async {
    final dir = await Directory.systemTemp.createTemp('remote_page_rollback_');
    final store = await LedgerStore.open(
      path: '${dir.path}/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    var notifications = 0;
    final subscription = store.changes.listen((_) => notifications++);
    try {
      for (final invalid in [
        {...reference.invoice(id: 'invalid_total').toJson(), 'totalMinor': 1},
        {...reference.invoice(id: 'other_tenant').toJson(), 'tenantId': 't2'},
      ]) {
        await expectLater(
          store.applyRemoteBatch([
            change('party', reference.merchant.toJson()),
            change('entry', reference.invoice().toJson()),
            change('entry', invalid),
          ]),
          throwsA(isA<LedgerException>()),
        );
        expect(await store.listParties(), isEmpty);
        expect(await store.listEntries(), isEmpty);
        expect((await store.exportBackup())['audit'], isEmpty);
      }
      final sale = reference.invoice();
      await expectLater(
        store.applyRemoteBatch([
          change('party', reference.merchant.toJson()),
          change('entry', sale.toJson()),
          change(
            'entry',
            reference.returned(sale, 'return_8000', 8000, [sale]).toJson(),
          ),
          change(
            'entry',
            reference.returned(sale, 'return_3000', 3000, [sale]).toJson(),
          ),
        ]),
        throwsA(isA<LedgerException>()),
      );
      expect(await store.listEntries(), isEmpty);
      expect((await store.exportBackup())['audit'], isEmpty);
      await expectLater(
        store.applyRemoteBatch(
          List.generate(
            LedgerStore.maxRemoteBatchSize + 1,
            (_) => change('party', reference.merchant.toJson()),
          ),
        ),
        throwsA(isA<LedgerException>()),
      );
      await Future<void>.delayed(Duration.zero);
      expect(notifications, 0);
    } finally {
      await subscription.cancel();
      await store.close();
      await dir.delete(recursive: true);
    }
  });

  test('Revocation arriving after the last batch audit still rolls the complete page back before commit', () async {
    final dir = await Directory.systemTemp.createTemp('remote_page_revoke_');
    late LedgerStore store;
    var revokeOnAudit = false;
    // Native operations remain real; the debug logger observes commit timing.
    // ignore: experimental_member_use
    final factory = SqfliteDatabaseFactoryLogger(
      databaseFactoryFfi,
      options: SqfliteLoggerOptions(
        log: (event) {
          if (revokeOnAudit &&
              event is SqfliteLoggerSqlEvent &&
              event.sql.startsWith('INSERT INTO audit')) {
            store.revokeAccess();
          }
        },
      ),
    );
    store = await LedgerStore.open(
      path: '${dir.path}/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: factory,
    );
    try {
      revokeOnAudit = true;
      await expectLater(
        store.applyRemoteBatch([change('party', reference.merchant.toJson())]),
        throwsA(
          isA<LedgerException>().having(
            (e) => e.code,
            'code',
            'access_revoked',
          ),
        ),
      );
      await store.close();
      store = await LedgerStore.open(
        path: '${dir.path}/ledger.db',
        tenantId: 't1',
        userId: 'u1',
        factory: databaseFactoryFfi,
      );
      expect(await store.listParties(), isEmpty);
      expect((await store.exportBackup())['audit'], isEmpty);
    } finally {
      await store.close();
      await dir.delete(recursive: true);
    }
  });

  test('Employee page cannot partly import a directory before forbidden financial data', () async {
    final dir = await Directory.systemTemp.createTemp('remote_page_employee_');
    final store = await LedgerStore.open(
      path: '${dir.path}/ledger.db',
      tenantId: 't1',
      userId: 'staff',
      role: 'employee',
      employeeId: 'e1',
      factory: databaseFactoryFfi,
    );
    try {
      await expectLater(
        store.applyRemoteBatch([
          change('party', {...reference.merchant.toJson(), 'openingMinor': 0}),
          change('entry', reference.invoice().toJson()),
        ]),
        throwsA(isA<LedgerException>()),
      );
      expect(await store.listParties(), isEmpty);
      expect(await store.listSubmissions(), isEmpty);
    } finally {
      await store.close();
      await dir.delete(recursive: true);
    }
  });

  test('Batch duplicate and immutable conflict handling preserve the original ledger and queue IDs', () async {
    final dir = await Directory.systemTemp.createTemp('remote_page_conflict_');
    final store = await LedgerStore.open(
      path: '${dir.path}/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    try {
      final original = reference.invoice();
      await store.saveParty(reference.merchant);
      await store.saveEntry(original);
      await store.applyRemoteBatch([
        change('entry', original.toJson()),
        change('entry', original.toJson()),
        change('entry', reference.invoice(paidMinor: 15000).toJson()),
      ]);
      expect((await store.listEntries()).single.toJson(), original.toJson());
      expect(await store.entryState(original.id), 'conflict');
      expect((await store.listConflicts()).single['id'], original.id);
      expect(
        (await store.listOutbox())
            .singleWhere((o) => o.id == original.id)
            .status,
        'conflict',
      );
    } finally {
      await store.close();
      await dir.delete(recursive: true);
    }
  });

  test('A 500-event page reads validation projections once and causes one complete UI snapshot', () async {
    final dir = await Directory.systemTemp.createTemp(
      'remote_page_read_count_',
    );
    final measurements = <String, Object?>{};
    try {
      for (final batched in [false, true]) {
        var entryScans = 0, queries = 0, refreshCalls = 0;
        // The debug-only logger measures actual FFI queries without mocking.
        // ignore: experimental_member_use
        final factory = SqfliteDatabaseFactoryLogger(
          databaseFactoryFfi,
          options: SqfliteLoggerOptions(
            log: (event) {
              if (event is SqfliteLoggerSqlEvent && event.name == 'query') {
                queries++;
                if (event.sql.startsWith('SELECT * FROM entries') &&
                    !event.sql.contains(' WHERE ')) {
                  entryScans++;
                }
              }
            },
          ),
        );
        final store = await LedgerStore.open(
          path: '${dir.path}/${batched ? 'page' : 'individual'}.db',
          tenantId: 't1',
          userId: 'u1',
          factory: factory,
        );
        final app = AppController()
          ..store = store
          ..license = const LicenseStatus(
            operationalAllowed: true,
            message: 'synthetic refresh probe',
            role: 'manager',
          );
        final active = <Future<void>>[];
        final subscription = store.changes.listen((_) {
          refreshCalls++;
          active.add(app.refresh());
        });
        final events = List.generate(
          500,
          (i) => change(
            'entry',
            LedgerEntry(
              id: 'page_expense_$i',
              tenantId: 't1',
              creatorUid: 'u1',
              kind: 'expense_business',
              date: '2026-10-18',
              totalMinor: 1250,
              paidMinor: 1250,
              category: 'وقود',
            ).toJson(),
          ),
        );
        entryScans = 0;
        queries = 0;
        final timer = Stopwatch()..start();
        try {
          if (batched) {
            await store.applyRemoteBatch(events);
          } else {
            for (final event in events) {
              await store.applyRemote(
                event['entity'] as String,
                Map<String, dynamic>.from(event['payload'] as Map),
              );
            }
          }
          await Future<void>.delayed(Duration.zero);
          await Future.wait(active);
          timer.stop();
          measurements[batched ? 'batch' : 'individual'] = {
            'milliseconds': timer.elapsedMilliseconds,
            'completeEntryScans': entryScans,
            'allQueryCalls': queries,
            'uiRefreshCalls': refreshCalls,
            'events': 500,
          };
          expect(app.entries.length, 500);
          if (batched) {
            expect(refreshCalls, 1);
            expect(entryScans, 2); // One validation load and one UI snapshot.
          } else {
            expect(refreshCalls, 500);
            expect(entryScans, 1000);
          }
        } finally {
          await subscription.cancel();
          await store.close();
          app.store = null;
          app.dispose();
        }
      }
      // Real host SQLite FFI metrics; these are not Android timings.
      // ignore: avoid_print
      print('REMOTE_PAGE_VERIFICATION ${jsonEncode(measurements)}');
    } finally {
      await dir.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
