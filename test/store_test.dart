import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';

import 'domain_test.dart' as reference;

void main() {
  late Directory folder;
  late String path;
  late LedgerStore store;
  Future<LedgerStore> open({
    String? at,
    String tenant = 't1',
    String uid = 'u1',
    String role = 'manager',
    String? employeeId,
  }) => LedgerStore.open(
    path: at ?? path,
    tenantId: tenant,
    userId: uid,
    role: role,
    employeeId: employeeId,
    factory: databaseFactoryFfi,
  );
  setUpAll(sqfliteFfiInit);
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('strawberry_sqlite_test_');
    path = '${folder.path}/ledger.db';
    store = await open();
    await store.saveParty(reference.merchant);
    await store.saveParty(reference.supplier);
  });
  tearDown(() async {
    await store.close();
    await folder.delete(recursive: true);
  });

  test(
    'Real on-disk save and stable outbox survive closing/reopening offline',
    () async {
      final entry = reference.invoice();
      await store.saveEntry(entry);
      await store.close();
      expect(await File(path).exists(), isTrue);
      expect(await File(path).length(), greaterThan(4096));
      store = await open();
      expect((await store.listEntries()).single.toJson(), entry.toJson());
      final item = (await store.listOutbox()).singleWhere(
        (o) => o.id == entry.id,
      );
      expect(item.toOperation()['payload'], entry.toJson());
      await store.saveEntry(entry); // retry/two taps with same form ID
      expect((await store.listEntries()).length, 1);
      expect(
        (await store.listOutbox()).where((o) => o.id == entry.id).length,
        1,
      );
      await store.acknowledge(
        entry.id,
        sessionUserId: 'u1',
        sessionTenantId: 't1',
      );
      await store.acknowledge(entry.id);
      expect(await store.entryState(entry.id), 'server_accepted');
      expect(
        (await store.listOutbox()).where((o) => o.id == entry.id),
        isEmpty,
      );
    },
  );
  test('Documented debt adjustments retain direction, immutable evidence and queue IDs after backup and reopen', () async {
    const adjustment = LedgerEntry(
      id: 'debt-adjustment',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'balance_adjustment',
      date: '2026-10-02',
      partyId: 'm1',
      partyName: 'عميل مرجعي',
      totalMinor: 7500,
      adjustmentDirection: 'decrease',
      note: 'مطابقة موثقة مع كشف العميل',
    );
    await Future.wait([
      store.saveEntry(adjustment),
      store.saveEntry(adjustment),
    ]);
    await expectLater(
      store.saveEntry(
        LedgerEntry.fromJson({
          ...adjustment.toJson(),
          'adjustmentDirection': 'increase',
        }),
      ),
      throwsA(isA<LedgerException>()),
    );
    await store.close();
    store = await open();
    expect((await store.listEntries()).single.toJson(), adjustment.toJson());
    final queue = (await store.listOutbox()).singleWhere(
      (o) => o.id == adjustment.id,
    );
    expect(queue.payload['adjustmentDirection'], 'decrease');
    expect(queue.toOperation()['id'], adjustment.id);
    expect(
      LedgerRules.partyBalance(reference.merchant, await store.listEntries()),
      -2500,
    );
    const reversal = LedgerEntry(
      id: 'adjustment-reversal',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-03',
      originalId: 'debt-adjustment',
      note: 'عكس موثق مع إبقاء التسوية الأصلية',
    );
    await store.saveEntry(reversal);
    final backup = await store.exportBackup();
    final restored = await open(at: '${folder.path}/adjustment-restored.db');
    try {
      await restored.restoreBackup(backup);
      final entries = await restored.listEntries();
      expect(entries.length, 2);
      expect(entries.first.toJson(), adjustment.toJson());
      expect(LedgerRules.partyBalance(reference.merchant, entries), 5000);
      expect(
        LedgerRules.statement(
          reference.merchant,
          entries,
        ).map((l) => l.balanceMinor),
        [-2500, 5000],
      );
      expect(LedgerRules.netRecordedCash(entries), 0);
      expect(
        (await restored.listOutbox())
            .where((o) => o.entity == 'entry')
            .map((o) => o.id)
            .toSet(),
        {adjustment.id, reversal.id},
      );
      final bad = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(backup)) as Map,
      );
      for (final row in bad['entries'] as List) {
        final payload = Map<String, dynamic>.from(
          jsonDecode(row['payload'] as String) as Map,
        );
        if (payload['id'] == adjustment.id) {
          payload['adjustmentDirection'] = 'arbitrary';
          row['payload'] = jsonEncode(payload);
        }
      }
      final invalid = await open(at: '${folder.path}/invalid-adjustment.db');
      try {
        await expectLater(
          invalid.restoreBackup(bad),
          throwsA(isA<LedgerException>()),
        );
        expect(await invalid.listEntries(), isEmpty);
        expect(await invalid.listParties(), isEmpty);
      } finally {
        await invalid.close();
      }
    } finally {
      await restored.close();
    }
  });
  test('Revoked handles block private reads, pending writes and callbacks while keeping durable data for reauthentication', () async {
    await store.saveEntry(reference.invoice());
    final pending = store.saveEntry(reference.invoice(id: 'racing-write'));
    store.revokeAccess();
    await expectLater(pending, throwsA(isA<LedgerException>()));
    for (final operation in <Future<Object?> Function()>[
      () => store.listEntries(),
      () => store.listParties(),
      () => store.listEmployees(),
      () => store.listSalaryTerms(),
      () => store.listOutbox(),
      () => store.listDrafts(),
      () => store.listConflicts(),
      () => store.exportBackup(),
      () => store.acknowledge('invoice'),
      () => store.retry('invoice'),
      () => store.fail('invoice', 'unavailable'),
      () => store.saveEntry(reference.invoice(id: 'after-revoke')),
    ]) {
      await expectLater(operation(), throwsA(isA<LedgerException>()));
    }
    await store.close();
    store = await open();
    expect((await store.listEntries()).single.id, 'invoice');
    expect(await store.entryState('invoice'), 'pending');
    expect(
      (await store.listOutbox()).where((o) => o.id == 'racing-write'),
      isEmpty,
    );
    expect((await store.listOutbox()).any((o) => o.id == 'invoice'), isTrue);
  });
  test('Immutable shipment updates round-trip through outbox and backup without rewriting financial invoice', () async {
    final original = reference.invoice();
    await store.saveEmployee(reference.employee);
    await store.saveEntry(original);
    final originalWire = (await store.listOutbox())
        .singleWhere((o) => o.id == original.id)
        .payload;
    const update = LedgerEntry(
      id: 'shipment-event',
      shipmentOrder: 1,
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'shipment_update',
      date: '2026-10-02',
      originalId: 'invoice',
      shippingEmployeeId: 'e1',
      shipmentRef: 'نقل-١',
      shipmentStatus: 'delivered',
      note: 'إثبات استلام العميل',
    );
    await store.saveEntry(update);
    await store.saveEntry(update);
    expect(
      (await store.listEntries())
          .where((e) => e.kind == 'shipment_update')
          .length,
      1,
    );
    expect(
      (await store.listOutbox())
          .singleWhere((o) => o.id == original.id)
          .payload,
      originalWire,
    );
    expect(
      (await store.listOutbox()).singleWhere((o) => o.id == update.id).payload,
      update.toJson(),
    );
    await expectLater(
      store.saveEntry(
        LedgerEntry.fromJson({...update.toJson(), 'shipmentStatus': 'pending'}),
      ),
      throwsA(isA<LedgerException>()),
    );
    final backup = await store.exportBackup();
    final restored = await open(at: '${folder.path}/shipment-restored.db');
    try {
      await restored.restoreBackup(backup);
      final facts = await restored.listEntries();
      expect(facts.first.toJson(), original.toJson());
      expect(
        LedgerRules.latestShipment(original, facts).shipmentStatus,
        'delivered',
      );
      expect(LedgerRules.partyBalance(reference.merchant, facts), 15000);
      expect(LedgerRules.netRecordedCash(facts), 10000);
      expect(
        (await restored.listOutbox())
            .singleWhere((o) => o.id == update.id)
            .payload,
        update.toJson(),
      );
    } finally {
      await restored.close();
    }
    final bad = Map<String, dynamic>.from(
      jsonDecode(jsonEncode(backup)) as Map,
    );
    for (final row in bad['entries'] as List) {
      final payload = Map<String, dynamic>.from(
        jsonDecode(row['payload'] as String) as Map,
      );
      if (payload['id'] == update.id) {
        payload['totalMinor'] = 100;
        row['payload'] = jsonEncode(payload);
      }
    }
    final invalid = await open(at: '${folder.path}/invalid-shipment.db');
    try {
      await expectLater(
        invalid.restoreBackup(bad),
        throwsA(isA<LedgerException>()),
      );
      expect(await invalid.listEntries(), isEmpty);
      expect(await invalid.listParties(), isEmpty);
    } finally {
      await invalid.close();
    }
  });
  test('Actual SQLite failure during outbox insertion rolls back ledger and preserves draft', () async {
    final entry = reference.invoice();
    await store.saveDraft(entry.id, entry.toJson());
    final raw = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(singleInstance: false),
    );
    await raw.execute(
      "CREATE TRIGGER force_outbox_failure BEFORE INSERT ON outbox WHEN NEW.id='invoice' BEGIN SELECT RAISE(ABORT, 'simulated disk transaction failure'); END",
    );
    await expectLater(
      store.saveEntry(entry),
      throwsA(isA<DatabaseException>()),
    );
    expect(await store.listEntries(), isEmpty);
    expect((await store.listOutbox()).where((o) => o.id == entry.id), isEmpty);
    expect((await store.listDrafts()).single['id'], entry.id);
    expect(
      (await raw.query(
        'audit',
        where: 'operation_id=?',
        whereArgs: [entry.id],
      )),
      isEmpty,
    );
    await raw.close();
  });
  test('Opening another tenant UID role or employee scope on an existing database fails', () async {
    for (final args in [
      () => open(tenant: 't2'),
      () => open(uid: 'u2'),
      () => open(role: 'employee', employeeId: 'e1'),
    ]) {
      await expectLater(args(), throwsA(isA<LedgerException>()));
    }
    await expectLater(
      store.saveParty(
        const Party(
          id: 'wrong',
          tenantId: 't2',
          name: 'غير مصرح',
          kind: 'merchant',
        ),
      ),
      throwsA(isA<LedgerException>()),
    );
    expect((await store.listParties()).length, 2);
  });
  test('Migration v1 to v2 preserves ledger, queue identifier and attempts on disk', () async {
    final entry = reference.invoice();
    await store.saveEntry(entry);
    await store.fail(entry.id, 'unavailable', nowMs: 1000);
    await store.close();
    final raw = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(singleInstance: false),
    );
    await raw.execute('DROP INDEX outbox_schedule');
    await raw.execute('ALTER TABLE outbox DROP COLUMN next_attempt_ms');
    await raw.execute('DROP TABLE conflicts');
    await raw.setVersion(1);
    await raw.close();
    store = await open();
    final queue = (await store.listOutbox()).singleWhere(
      (o) => o.id == entry.id,
    );
    expect(queue.id, 'invoice');
    expect(queue.attempts, 1);
    expect(queue.nextAttemptMs, 0);
    expect((await store.listEntries()).single.id, 'invoice');
    final check = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(singleInstance: false),
    );
    expect(await check.getVersion(), 2);
    await check.close();
  });
  test('Optional field defaults after an APK upgrade do not alter pending wire payloads', () async {
    final invoice = reference.invoice();
    await store.saveEntry(invoice);
    final raw = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(singleInstance: false),
    );
    final old = invoice.toJson()
      ..remove('category')
      ..remove('shippingEmployeeId')
      ..remove('shipmentRef')
      ..remove('shipmentStatus')
      ..remove('shipmentOrder')
      ..remove('adjustmentDirection');
    final oldJson = jsonEncode(old);
    await raw.update(
      'entries',
      {'payload': oldJson},
      where: 'id=?',
      whereArgs: [invoice.id],
    );
    await raw.update(
      'outbox',
      {'payload': oldJson},
      where: 'id=?',
      whereArgs: [invoice.id],
    );
    await raw.close();
    await store.close();
    store = await open();
    await store.saveEntry(invoice);
    expect(
      (await store.listOutbox()).singleWhere((o) => o.id == invoice.id).payload,
      old,
    );
    await store.applyRemote('entry', invoice.toJson());
    expect(await store.listConflicts(), isEmpty);
    final backup = await store.exportBackup();
    final restored = await open(at: '${folder.path}/old-wire-restored.db');
    try {
      await restored.restoreBackup(backup);
      expect(
        (await restored.listOutbox())
            .singleWhere((o) => o.id == invoice.id)
            .payload,
        old,
      );
    } finally {
      await restored.close();
    }
  });
  test('Retries keep IDs and durable attempts; auth/license failure never drops operations', () async {
    await store.saveEntry(reference.invoice());
    await store.fail('invoice', 'unavailable', nowMs: 1000);
    var queue = (await store.listOutbox()).singleWhere(
      (o) => o.id == 'invoice',
    );
    expect(queue.status, 'retry');
    expect(queue.attempts, 1);
    expect(queue.nextAttemptMs, 3000);
    expect(
      (await store.listOutbox(
        dueOnly: true,
        nowMs: 2000,
      )).where((o) => o.id == 'invoice'),
      isEmpty,
    );
    await store.fail('invoice', 'license_expired', nowMs: 3000);
    await store.close();
    store = await open();
    queue = (await store.listOutbox()).singleWhere((o) => o.id == 'invoice');
    expect(queue.status, 'blocked');
    expect(queue.attempts, 2);
    await store.retry('invoice');
    queue = (await store.listOutbox()).singleWhere((o) => o.id == 'invoice');
    expect(queue.status, 'pending');
    expect(queue.id, 'invoice');
  });
  test('Late acknowledgment cannot change a different session; closed store rejects callbacks', () async {
    await store.saveEntry(reference.invoice());
    await expectLater(
      store.acknowledge('invoice', sessionUserId: 'u2'),
      throwsA(isA<LedgerException>()),
    );
    expect(await store.entryState('invoice'), 'pending');
    await store.close();
    await expectLater(
      store.acknowledge('invoice'),
      throwsA(isA<LedgerException>()),
    );
    store = await open();
    expect((await store.listOutbox()).any((o) => o.id == 'invoice'), isTrue);
  });
  test(
    'Two concurrent local returns cannot exceed original quantity',
    () async {
      final sale = reference.invoice();
      await store.saveEntry(sale);
      final r1 = reference.returned(sale, 'r1', 8000, [sale]);
      final r2 = reference.returned(sale, 'r2', 3000, [sale]);
      final results = await Future.wait([
        store.saveEntry(r1).then((_) => true).catchError((_) => false),
        store.saveEntry(r2).then((_) => true).catchError((_) => false),
      ]);
      expect(results.where((r) => r).length, 1);
      expect((await store.listEntries()).length, 2);
    },
  );
  test(
    'Conflicting remote facts preserve both versions and block resend',
    () async {
      final sale = reference.invoice();
      await store.saveEntry(sale);
      final changed = reference.invoice(paidMinor: 15000);
      await store.applyRemote('entry', changed.toJson());
      expect((await store.listEntries()).single.paidMinor, 10000);
      final conflict = (await store.listConflicts()).single;
      expect(
        (jsonDecode(conflict['remote_payload']! as String) as Map)['paidMinor'],
        15000,
      );
      expect(
        (await store.listOutbox()).singleWhere((o) => o.id == sale.id).status,
        'conflict',
      );
      await expectLater(store.retry(sale.id), throwsA(isA<LedgerException>()));
    },
  );
  test('Remote field reordering does not create false conflicts and confirms restored state', () async {
    final entry = reference.invoice();
    await store.saveEntry(entry);
    final reordered = {
      for (final key in entry.toJson().keys.toList().reversed)
        key: entry.toJson()[key],
    };
    await store.applyRemote('entry', reordered);
    expect(await store.listConflicts(), isEmpty);
    expect(await store.entryState(entry.id), 'server_accepted');
  });
  test('Trusted submission metadata updates approval without importing financial fields', () async {
    const submission = EmployeeSubmission(
      id: 'remote-staff',
      tenantId: 't1',
      creatorUid: 'staff1',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-03',
      amountMinor: 1000,
      category: 'وقود ومواصلات',
    );
    await store.applyRemote('submission', {
      ...submission.toJson(),
      'status': 'pending',
      'recordedByUid': 'staff1',
      'recordedAtMs': 1,
    });
    expect(
      (await store.listSubmissions()).single['state'],
      'awaiting_approval',
    );
    await store.applyRemote('submission', {
      ...submission.toJson(),
      'status': 'approved',
      'recordedByUid': 'staff1',
      'recordedAtMs': 1,
    });
    expect((await store.listSubmissions()).single['state'], 'approved');
    expect(await store.listConflicts(), isEmpty);
    await store.applyRemote('submission', {
      ...submission.toJson(),
      'status': 'pending',
      'recordedByUid': 'staff1',
      'recordedAtMs': 1,
    });
    expect((await store.listSubmissions()).single['state'], 'approved');
    await expectLater(
      store.applyRemote('submission', {
        ...submission.toJson(),
        'status': 'approved',
        'priceMinor': 999,
      }),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Explicit conflict resolution keeps old facts and accepts only validated server version', () async {
    await store.saveEntry(reference.invoice());
    await store.applyRemote(
      'entry',
      reference.invoice(paidMinor: 15000).toJson(),
    );
    await store.resolveConflict(
      'invoice',
      note: 'مراجعة الفاتورة الأصلية وموافقة المدير على نسخة الخادم',
      acceptRemote: true,
    );
    expect((await store.listEntries()).single.paidMinor, 15000);
    expect((await store.listOutbox()).where((o) => o.id == 'invoice'), isEmpty);
    final evidence = (await store.listConflicts()).single;
    expect(
      (jsonDecode(evidence['local_payload']! as String) as Map)['paidMinor'],
      10000,
    );
    expect(evidence['resolution'], contains('موافقة المدير'));
  });
  test(
    'A server version that invalidates existing returns cannot be accepted',
    () async {
      final sale = reference.invoice();
      await store.saveEntry(sale);
      await store.saveEntry(reference.returned(sale, 'r1', 8000, [sale]));
      await store.applyRemote(
        'entry',
        reference.invoice(qtyMilli: 5000, paidMinor: 1000).toJson(),
      );
      await expectLater(
        store.resolveConflict(
          'invoice',
          note: 'محاولة لا تجوز',
          acceptRemote: true,
        ),
        throwsA(isA<LedgerException>()),
      );
      expect((await store.listEntries()).first.qtyMilli, 10000);
      expect((await store.listConflicts()).single['resolution'], isNull);
    },
  );
  test('Incomplete employee draft survives reopen but private price fields are refused', () async {
    final employeePath = '${folder.path}/draft-employee.db';
    var e = await open(
      at: employeePath,
      uid: 'staff1',
      role: 'employee',
      employeeId: 'e1',
    );
    final draft = <String, dynamic>{
      'id': 'draft_staff',
      'tenantId': 't1',
      'creatorUid': 'staff1',
      'employeeId': 'e1',
      'kind': 'delivery',
      'date': '',
      'partyId': '',
      'partyName': '',
      'qtyMilli': 0,
      'grade': '',
      'unit': '',
      'originalId': '',
      'amountMinor': 0,
      'note': '',
      'qtyText': '١٢٫',
    };
    await e.saveDraft('draft_staff', draft);
    await e.close();
    e = await open(
      at: employeePath,
      uid: 'staff1',
      role: 'employee',
      employeeId: 'e1',
    );
    try {
      expect((await e.listDrafts()).single['qtyText'], '١٢٫');
      await expectLater(
        e.saveDraft('draft_staff', {...draft, 'priceText': '100'}),
        throwsA(isA<LedgerException>()),
      );
    } finally {
      await e.close();
    }
  });
  test('Review is provisional, double taps reuse its ID and only server acceptance posts employee facts', () async {
    const submission = EmployeeSubmission(
      id: 'staff-submission',
      tenantId: 't1',
      creatorUid: 'staff1',
      employeeId: 'e1',
      kind: 'delivery',
      date: '2026-10-02',
      partyId: 'm1',
      partyName: 'عميل مرجعي',
      qtyMilli: 1000,
      grade: 'أ',
      unit: 'كيلو',
    );
    await store.applyRemote('submission', submission.toJson());
    const canonical = LedgerEntry(
      id: 'staff-entry',
      tenantId: 't1',
      creatorUid: 'staff1',
      kind: 'sale',
      date: '2026-10-02',
      partyId: 'm1',
      partyName: 'عميل مرجعي',
      qtyMilli: 1000,
      priceMinor: 2000,
      totalMinor: 2000,
      paidMinor: 0,
      grade: 'أ',
      unit: 'كيلو',
    );
    await Future.wait([
      store.saveReview(
        id: 'review1',
        submissionId: submission.id,
        approved: true,
        entry: canonical,
      ),
      store.saveReview(
        id: 'review1',
        submissionId: submission.id,
        approved: true,
        entry: canonical,
      ),
    ]);
    expect(await store.listEntries(), isEmpty);
    expect(
      (await store.listOutbox()).where((o) => o.entity == 'review').length,
      1,
    );
    await store.acknowledge('review1', serverEntry: canonical.toJson());
    await store.acknowledge('review1', serverEntry: canonical.toJson());
    expect((await store.listEntries()).single.creatorUid, 'staff1');
    expect((await store.listSubmissions()).single['state'], 'approved');
  });
  test('Backup round-trip into a different device retains immutable ledger and pending operation IDs without authority', () async {
    await store.saveEntry(reference.invoice());
    await store.saveDraft('draft1', {'id': 'draft1', 'note': 'مسودة لم تكتمل'});
    final backup = await store.exportBackup();
    expect(
      backup.keys.any(
        (k) =>
            {'license', 'membership', 'credentials', 'deviceKey'}.contains(k),
      ),
      isFalse,
    );
    final restored = await open(at: '${folder.path}/new-device.db');
    try {
      await restored.restoreBackup(backup);
      await restored.restoreBackup(backup);
      expect((await restored.listEntries()).single.id, 'invoice');
      expect(
        (await restored.listOutbox()).map((o) => o.id).toSet(),
        (await store.listOutbox()).map((o) => o.id).toSet(),
      );
      expect((await restored.listDrafts()).single['id'], 'draft1');
      expect(
        LedgerRules.partyBalance(
          reference.merchant,
          await restored.listEntries(),
        ),
        15000,
      );
    } finally {
      await restored.close();
    }
  });
  test('Invalid backup totals, paid amounts, changed grade and forged authority are atomically rejected', () async {
    final sale = reference.invoice();
    await store.saveEntry(sale);
    await store.saveEntry(reference.returned(sale, 'r1', 1000, [sale]));
    final backup = await store.exportBackup();
    for (final mutation in <void Function(Map<String, dynamic>)>[
      (b) {
        final rows = b['entries'] as List;
        final row = rows.first as Map;
        final j = jsonDecode(row['payload'] as String) as Map;
        j['totalMinor'] = 1;
        row['payload'] = jsonEncode(j);
      },
      (b) {
        final rows = b['entries'] as List;
        final row = rows.first as Map;
        final j = jsonDecode(row['payload'] as String) as Map;
        j['paidMinor'] = 500000;
        row['payload'] = jsonEncode(j);
      },
      (b) {
        final rows = b['entries'] as List;
        final row = rows.last as Map;
        final j = jsonDecode(row['payload'] as String) as Map;
        j['grade'] = 'درجة مزورة';
        row['payload'] = jsonEncode(j);
      },
      (b) {
        b['membership'] = {'role': 'manager'};
      },
      (b) {
        b['tenantId'] = 't2';
      },
    ]) {
      final modified = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(backup)) as Map,
      );
      mutation(modified);
      final restored = await open(at: '${folder.path}/${newId()}.db');
      try {
        await expectLater(
          restored.restoreBackup(modified),
          throwsA(isA<LedgerException>()),
        );
        expect(await restored.listEntries(), isEmpty);
        expect(await restored.listParties(), isEmpty);
      } finally {
        await restored.close();
      }
    }
  });
  test(
    'Historical salary cannot be retroactively rewritten after payment',
    () async {
      await store.saveEmployee(reference.employee);
      await store.saveSalaryTerm(reference.october);
      await store.saveEntry(
        reference.payment(
          'payroll',
          'payroll',
          10000,
          employeeId: 'e1',
          salaryMonth: '2026-11',
        ),
      );
      const retro = SalaryTerm(
        id: 'retro',
        tenantId: 't1',
        employeeId: 'e1',
        effectiveMonth: '2026-11',
        monthlyMinor: 400000,
      );
      await expectLater(
        store.saveSalaryTerm(retro),
        throwsA(isA<LedgerException>()),
      );
      expect(
        LedgerRules.payroll(
          'e1',
          '2026-11',
          await store.listSalaryTerms(),
          await store.listEntries(),
        ).entitlementMinor,
        300000,
      );
    },
  );
  test('Employee store never accepts financial ledger, balance download, payroll, backup or impersonation', () async {
    final employeeStore = await open(
      at: '${folder.path}/employee.db',
      uid: 'staff1',
      role: 'employee',
      employeeId: 'e1',
    );
    try {
      await expectLater(
        employeeStore.listEntries(),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        employeeStore.exportBackup(),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        employeeStore.saveEntry(reference.invoice()),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        employeeStore.applyRemote('party', reference.merchant.toJson()),
        throwsA(isA<LedgerException>()),
      );
      final redacted = reference.merchant.toJson()..['openingMinor'] = 0;
      await employeeStore.applyRemote('party', redacted);
      const submission = EmployeeSubmission(
        id: 'submission',
        tenantId: 't1',
        creatorUid: 'staff1',
        employeeId: 'e1',
        kind: 'delivery',
        date: '2026-10-02',
        partyId: 'm1',
        partyName: 'عميل مرجعي',
        qtyMilli: 1000,
        grade: 'أ',
        unit: 'كيلو',
      );
      await Future.wait([
        employeeStore.saveSubmission(submission),
        employeeStore.saveSubmission(submission),
      ]);
      expect((await employeeStore.listSubmissions()).length, 1);
      expect((await employeeStore.listOutbox()).length, 1);
      final forged = submission.toJson()..['creatorUid'] = 'staff2';
      await expectLater(
        employeeStore.saveSubmission(EmployeeSubmission.fromJson(forged)),
        throwsA(isA<LedgerException>()),
      );
      expect((await employeeStore.listParties()).single.openingMinor, 0);
    } finally {
      await employeeStore.close();
    }
  });
  test('Immutable entries reject silent editing while search parameters cannot inject SQL', () async {
    await store.saveEntry(reference.invoice());
    await expectLater(
      store.saveEntry(reference.invoice(paidMinor: 15000)),
      throwsA(isA<LedgerException>()),
    );
    expect(await store.listEntries(partyId: "' OR 1=1 --"), isEmpty);
    expect((await store.listEntries()).length, 1);
  });
  test('Multi-season ledger is not truncated to latest 50 and supports historical pagination', () async {
    for (var i = 0; i < 120; i++) {
      await store.saveEntry(
        reference.invoice(
          id: 'season_$i',
          date: '2025-01-${(i % 28 + 1).toString().padLeft(2, '0')}',
        ),
      );
    }
    expect((await store.listEntries()).length, 120);
    final first = await store.listEntries(limit: 50);
    final second = await store.listEntries(limit: 50, offset: 50);
    final third = await store.listEntries(limit: 50, offset: 100);
    expect(
      {
        ...first.map((e) => e.id),
        ...second.map((e) => e.id),
        ...third.map((e) => e.id),
      }.length,
      120,
    );
    expect(await store.listEntries(from: '2026-01-01'), isEmpty);
  });
}
