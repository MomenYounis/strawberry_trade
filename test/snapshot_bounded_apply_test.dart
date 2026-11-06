import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common/sqflite_logger.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';

import 'active_snapshot_test.dart' show Fixture, code, record;
import 'domain_test.dart' as reference;

void main() {
  setUpAll(sqfliteFfiInit);
  late Directory directory;
  late LedgerStore store;
  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'snapshot-bounded-apply-',
    );
  });
  tearDown(() async {
    await store.close();
    await directory.delete(recursive: true);
  });
  Future<void> open({DatabaseFactory? factory}) async {
    store = await LedgerStore.open(
      path: '${directory.path}/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: factory ?? databaseFactoryFfi,
    );
  }

  test('annual invoices and growth use bounded bulk reads and native write batches', () async {
    final events = <SqfliteLoggerEvent>[];
    // Observe real SQLite operations, including the actual batch boundaries.
    await open(
      // ignore: experimental_member_use
      factory: SqfliteDatabaseFactoryLogger(
        databaseFactoryFfi,
        options: SqfliteLoggerOptions(log: events.add),
      ),
    );
    for (final count in [64, 96]) {
      final fixture = Fixture(
        [
          record('party', reference.merchant.toJson(), count + 1),
          for (var index = 1; index <= count; index++)
            record(
              'entry',
              reference.invoice(id: 'sale_$index').toJson(),
              index,
            ),
        ],
        id: 'annual_$count',
        checkpoint: count + 1,
        floor: 0,
        pageSize: 8,
      );
      await fixture.stage(store);
      events.clear();
      await fixture.install(store);
      final entryReads = events
          .whereType<SqfliteLoggerSqlEvent>()
          .where((event) => event.sql.startsWith('SELECT * FROM entries'))
          .toList();
      expect(entryReads.length, count ~/ 16);
      for (final event in entryReads) {
        expect(event.sql, contains(' WHERE id IN ('));
        expect((event.arguments! as List).length, lessThanOrEqualTo(16));
      }
      expect(
        events.whereType<SqfliteLoggerSqlEvent>().where(
          (event) =>
              event.sql.startsWith('INSERT INTO entries') ||
              event.sql.startsWith('UPDATE entries'),
        ),
        isEmpty,
        reason: 'Entry writes must cross the native channel in batches',
      );
      final entryBatches = events
          .whereType<SqfliteLoggerBatchEvent>()
          .where(
            (event) => event.operations.any(
              (operation) =>
                  operation.sql.startsWith('INSERT INTO entries') ||
                  operation.sql.startsWith('UPDATE entries'),
            ),
          )
          .toList();
      expect(entryBatches.length, count ~/ 16);
      expect(
        entryBatches.every((event) => event.operations.length <= 32),
        isTrue,
      );
      expect((await store.listEntries()).length, count);
      expect(
        LedgerRules.partyBalance(reference.merchant, await store.listEntries()),
        5000 + count * 10000,
      );
      final audits = (await store.exportBackup())['audit']! as List;
      expect(
        audits.where((row) => (row as Map)['action'] == 'remote_entry').length,
        count,
        reason: 'Matching growth rows must not acquire duplicate audits',
      );
    }
  });

  test('linked returns, reversed returns, shipment updates and payroll observe preceding bulk inserts', () async {
    await open();
    final invoice = reference.invoice();
    final returned = reference.returned(invoice, 'return_1', 1000, [invoice]);
    final reversal = LedgerEntry(
      id: 'reverse_return',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-06',
      originalId: returned.id,
      note: 'Correct return',
    );
    final replacement = reference.returned(invoice, 'return_2', 10000, [
      invoice,
      returned,
      reversal,
    ]);
    final shipment = LedgerEntry(
      id: 'shipment',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'shipment_update',
      date: '2026-10-06',
      originalId: invoice.id,
      shipmentOrder: 1,
      shippingEmployeeId: 'e1',
      shipmentStatus: 'delivered',
      note: 'Delivered',
    );
    final payroll = reference.payment(
      'payroll',
      'payroll',
      300,
      employeeId: 'e1',
      salaryMonth: '2026-10',
    );
    final payment = reference.payment(
      'payment',
      'merchant_payment',
      500,
      partyId: 'm1',
      partyName: reference.merchant.name,
    );
    final entries = [
      invoice,
      returned,
      reversal,
      replacement,
      shipment,
      payroll,
      payment,
    ];
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('employee', reference.employee.toJson(), 2),
      record('salary_term', reference.october.toJson(), 3),
      for (var index = 0; index < entries.length; index++)
        record('entry', entries[index].toJson(), index + 4),
    ], pageSize: 8);
    await fixture.stage(store);
    await fixture.install(store);
    expect((await store.listEntries()).length, entries.length);
    expect(
      LedgerRules.partyBalance(reference.merchant, await store.listEntries()),
      -5500,
    ); // 5000 opening + 10000 sale - 20000 active return - 500 receipt.
    expect(await store.entryState(payroll.id), 'server_accepted');
  });

  test('a late batch collision rolls back prior batches without changing pending wire, retries, drafts or audits', () async {
    await open();
    await store.saveParty(reference.merchant);
    final queued = reference.invoice(id: 'queued');
    await store.saveEntry(queued);
    await store.fail(queued.id, 'offline', nowMs: 1234);
    await store.saveDraft('draft', {'qtyText': '١٢٫'});
    final before = await store.exportBackup();
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      for (var index = 0; index < 20; index++)
        record(
          'entry',
          reference.invoice(id: 'new_$index').toJson(),
          index + 2,
        ),
      record('entry', {...queued.toJson(), 'note': 'Conflicting facts'}, 22),
    ], pageSize: 8);
    await fixture.stage(store);
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_immutable_conflict')),
    );
    expect((await store.listEntries()).single.toJson(), queued.toJson());
    final after = await store.exportBackup();
    for (final key in ['outbox', 'drafts', 'conflicts', 'audit']) {
      expect(after[key], before[key], reason: key);
    }
    expect(await store.entryState(queued.id), 'retry');
    expect(await store.preference('cursor'), isNull);
  });

  test('matching pending entries retain receipt state and attach immutable server correction provenance', () async {
    await open();
    await store.saveParty(reference.merchant);
    final queued = reference.invoice(id: 'queued', date: '2027-09-01');
    await store.saveEntry(queued);
    await store.fail(queued.id, 'offline', nowMs: 1234);
    final before = await store.exportBackup();
    Map<String, dynamic> corrected(String originalDate) => {
      ...queued.toJson(),
      'originalBusinessDate': originalDate,
      'correctionOfOperationId': 'prior_rejected_operation',
    };
    Fixture fixture(String id, String originalDate, int checkpoint) => Fixture(
      [
        record('party', reference.merchant.toJson(), 1),
        record('entry', corrected(originalDate), 2),
      ],
      id: id,
      checkpoint: checkpoint,
    );
    final accepted = fixture('provenance', '2027-08-31', 100);
    await accepted.stage(store);
    await accepted.install(store);
    final entry = (await store.listEntries()).single;
    expect(entry.originalBusinessDate, '2027-08-31');
    expect(entry.correctionOfOperationId, 'prior_rejected_operation');
    expect(await store.entryState(queued.id), 'retry');
    expect((await store.exportBackup())['outbox'], before['outbox']);
    final conflicting = fixture('changed_provenance', '2027-08-30', 101);
    await conflicting.stage(store);
    await expectLater(
      conflicting.install(store),
      throwsA(code('correction_provenance')),
    );
    expect(
      (await store.listEntries()).single.originalBusinessDate,
      '2027-08-31',
    );
    expect(await store.preference('cursor'), 100);
  });

  test('revocation after the native batch executes still rolls all financial facts back', () async {
    var revokeAfterBatch = false;
    await open(
      // ignore: experimental_member_use
      factory: SqfliteDatabaseFactoryLogger(
        databaseFactoryFfi,
        options: SqfliteLoggerOptions(
          log: (event) {
            if (revokeAfterBatch &&
                event is SqfliteLoggerBatchEvent &&
                event.operations.any(
                  (operation) =>
                      operation.sql.startsWith('INSERT INTO entries'),
                )) {
              store.revokeAccess();
            }
          },
        ),
      ),
    );
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('entry', reference.invoice().toJson(), 2),
    ]);
    await fixture.stage(store);
    revokeAfterBatch = true;
    await expectLater(fixture.install(store), throwsA(code('access_revoked')));
    await store.close();
    await open();
    expect(await store.listEntries(), isEmpty);
    expect(await store.preference('cursor'), isNull);
    expect((await store.exportBackup())['audit'], isEmpty);
  });
}
