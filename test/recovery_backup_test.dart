import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/recovery_backup.dart';

import 'domain_test.dart' as reference;
import 'active_snapshot_test.dart' show Fixture, record;

void main() {
  setUpAll(sqfliteFfiInit);
  const password = 'Separate recovery phrase 2026';
  test('employee portable recovery retains own pending submissions without managerial facts or authority', () async {
    final dir = await Directory.systemTemp.createTemp('employee-recovery-');
    Future<LedgerStore> open(String name) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: 't1',
      userId: 'worker',
      role: 'employee',
      employeeId: 'e1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    try {
      await source.applyRemoteBatch(
        [
          {
            'entity': 'party',
            'payload': {...reference.merchant.toJson(), 'openingMinor': 0},
          },
        ],
        expectedCursor: 0,
        lastSequence: 1,
      );
      final submission = EmployeeSubmission(
        id: 'pending_employee',
        tenantId: 't1',
        creatorUid: 'worker',
        employeeId: 'e1',
        kind: 'delivery',
        date: '2026-10-18',
        partyId: 'm1',
        partyName: reference.merchant.name,
        qtyMilli: 1000,
        grade: 'A',
        unit: 'kg',
      );
      await source.saveSubmission(submission);
      await source.fail(
        submission.id,
        'synthetic-conflict',
        conflict: true,
        nowMs: 55,
      );
      final backup = await source.exportPendingBackup();
      expect(backup['entries'], isEmpty);
      expect(backup['employees'], isEmpty);
      expect((backup['conflicts'] as List).length, 1);
      await replacement.restoreBackup(backup);
      expect(await replacement.listConflicts(), await source.listConflicts());
      expect(
        (await replacement.listOutbox()).single.toOperation(),
        (await source.listOutbox()).single.toOperation(),
      );
      await expectLater(
        replacement.restoreBackup({
          ...backup,
          'entries': [
            {
              'payload': jsonEncode(reference.invoice().toJson()),
              'state': 'pending',
            },
          ],
        }),
        throwsA(isA<LedgerException>()),
      );
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test('pending-only recovery includes chronological return dependencies and exact residual allocation', () async {
    final dir = await Directory.systemTemp.createTemp('return-recovery-');
    Future<LedgerStore> open(String n) => LedgerStore.open(
      path: '${dir.path}/$n.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    try {
      await source.saveParty(reference.merchant);
      await source.acknowledge('m1');
      final sale = reference.invoice(
        id: 'tiny',
        qtyMilli: 3,
        priceMinor: 500,
        paidMinor: 0,
      );
      await source.saveEntry(sale);
      await source.acknowledge(sale.id);
      final first = reference.returned(sale, 'first', 1, [sale]);
      await source.saveEntry(first);
      await source.acknowledge(first.id);
      final last = reference.returned(sale, 'last', 2, [sale, first]);
      await source.saveEntry(last);
      final backup = await source.exportPendingBackup();
      await replacement.restoreBackup(backup);
      expect((await replacement.listEntries()).length, 3);
      expect((await replacement.listOutbox()).single.id, 'last');
      expect(
        LedgerRules.partyBalance(
          reference.merchant,
          await replacement.listEntries(),
        ),
        5000,
      );
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test('replacement store restores saved pending IDs, attempts and drafts; unsaved lost-only operation is absent', () async {
    final dir = await Directory.systemTemp.createTemp('replacement-recovery-');
    Future<LedgerStore> open(
      String name, {
      String uid = 'u1',
      String tenant = 't1',
    }) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: tenant,
      userId: uid,
      factory: databaseFactoryFfi,
    );
    final source = await open('lost'),
        replacement = await open('replacement'),
        other = await open('other', tenant: 'other');
    try {
      await source.saveParty(reference.merchant);
      await source.acknowledge(reference.merchant.id);
      await source.saveEntry(reference.invoice(id: 'server_accepted'));
      await source.acknowledge('server_accepted');
      await source.saveEntry(reference.invoice(id: 'saved_pending'));
      await source.fail('saved_pending', 'unavailable', nowMs: 12345);
      await source.saveDraft('draft_saved', {
        'id': 'draft_saved',
        'note': 'recover me',
      });
      final pendingBackup = await source.exportPendingBackup();
      expect(pendingBackup['coverage'], 'pending-and-dependencies');
      expect((pendingBackup['entries'] as List).length, 1);
      expect((pendingBackup['outbox'] as List).length, 1);
      final backup = await source.exportBackup(
        maxBytes: RecoveryBackup.maxPlaintextBytes,
      );
      final envelope = await RecoveryBackup.encrypt(backup, password);
      final copy = File('${dir.path}/durable-test-copy.json');
      await copy.writeAsString(jsonEncode(envelope), flush: true);
      // This operation has neither a server receipt nor a copy in the backup.
      await source.saveEntry(reference.invoice(id: 'lost_only'));
      final decoded = await RecoveryBackup.decrypt(
        Map<String, dynamic>.from(jsonDecode(await copy.readAsString()) as Map),
        password,
      );
      await expectLater(
        other.restoreBackup(decoded),
        throwsA(isA<LedgerException>()),
      );
      await replacement.restoreBackup(decoded);
      await replacement.restoreBackup(decoded); // idempotent re-import
      expect((await replacement.listEntries()).map((e) => e.id).toSet(), {
        'server_accepted',
        'saved_pending',
      });
      final queue = (await replacement.listOutbox()).single;
      final original = (await source.listOutbox()).firstWhere(
        (o) => o.id == 'saved_pending',
      );
      expect(queue.toOperation(), original.toOperation());
      expect(queue.attempts, original.attempts);
      expect(queue.nextAttemptMs, original.nextAttemptMs);
      expect((await replacement.listDrafts()).single['id'], 'draft_saved');
      expect(
        LedgerRules.partyBalance(
          reference.merchant,
          await replacement.listEntries(),
        ),
        25000,
      );
      expect(await replacement.preference('licensePackage'), isNull);
      expect(await replacement.preference('cursor'), isNull);
    } finally {
      await source.close();
      await replacement.close();
      await other.close();
      await dir.delete(recursive: true);
    }
  });
  test('pending recovery preserves conflicts and retry states; divergent draft or evidence aborts every row', () async {
    final dir = await Directory.systemTemp.createTemp('conflict-recovery-');
    Future<LedgerStore> open(String name) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    try {
      await source.saveParty(reference.merchant);
      await source.acknowledge('m1');
      await source.saveEntry(reference.invoice(id: 'retry_copy'));
      await source.fail('retry_copy', 'unavailable', nowMs: 123);
      await source.saveEntry(reference.invoice(id: 'conflict_copy'));
      await source.fail(
        'conflict_copy',
        'immutable_remote_conflict',
        conflict: true,
        nowMs: 456,
      );
      await source.saveDraft('saved_draft', {
        'id': 'saved_draft',
        'note': 'original',
      });
      final backup = await source.exportPendingBackup();
      expect((backup['conflicts'] as List).length, 1);
      final envelope = await RecoveryBackup.encrypt(backup, password);
      final decoded = await RecoveryBackup.decrypt(envelope, password);
      await replacement.restoreBackup(decoded);
      expect(await replacement.entryState('retry_copy'), 'retry');
      expect(await replacement.entryState('conflict_copy'), 'conflict');
      expect(await replacement.listConflicts(), await source.listConflicts());
      expect(
        (await replacement.listOutbox()).map((o) => o.toOperation()),
        (await source.listOutbox()).map((o) => o.toOperation()),
      );
      expect(await replacement.preference('cursor'), isNull);
      await replacement.restoreBackup(decoded);
      final bad = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(decoded)) as Map,
      );
      (bad['drafts'] as List).single['payload'] = jsonEncode({
        'id': 'saved_draft',
        'note': 'different',
      });
      await expectLater(
        replacement.restoreBackup(bad),
        throwsA(
          isA<LedgerException>().having(
            (e) => e.code,
            'code',
            'backup_conflict',
          ),
        ),
      );
      expect((await replacement.listDrafts()).single['note'], 'original');
      final forged = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(decoded)) as Map,
      );
      (forged['conflicts'] as List).single['reason'] = 'changed evidence';
      await expectLater(
        replacement.restoreBackup(forged),
        throwsA(
          isA<LedgerException>().having(
            (e) => e.code,
            'code',
            'backup_conflict',
          ),
        ),
      );
      expect(await replacement.listConflicts(), await source.listConflicts());
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test('saved provisional approval survives replacement and snapshot proof without becoming an implicit receipt', () async {
    final dir = await Directory.systemTemp.createTemp('approval-recovery-');
    Future<LedgerStore> open(String name) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    const submission = EmployeeSubmission(
      id: 'approval_submission',
      tenantId: 't1',
      creatorUid: 'worker',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-18',
      amountMinor: 500,
      category: 'fuel',
    );
    const entry = LedgerEntry(
      id: 'approved_entry',
      tenantId: 't1',
      creatorUid: 'worker',
      kind: 'expense_business',
      date: '2026-10-18',
      totalMinor: 500,
      paidMinor: 500,
      category: 'fuel',
    );
    try {
      await source.applyRemote('submission', submission.toJson());
      await source.saveReview(
        id: 'saved_review',
        submissionId: submission.id,
        approved: true,
        entry: entry,
        note: 'saved',
      );
      await source.fail('saved_review', 'unavailable', nowMs: 333);
      final backup = await source.exportPendingBackup();
      await replacement.restoreBackup(backup);
      expect(await replacement.listEntries(), isEmpty);
      expect(
        (await replacement.listSubmissions()).single['state'],
        'review_pending',
      );
      expect(
        (await replacement.listSubmissions()).single['review'],
        (await source.listSubmissions()).single['review'],
      );
      final before = (await replacement.listOutbox()).single;
      final fixture = Fixture([
        record('submission', {...submission.toJson(), 'status': 'approved'}, 1),
        record('entry', entry.toJson(), 2),
        record('review', {
          'id': 'saved_review',
          'tenantId': 't1',
          'submissionId': submission.id,
          'decision': 'approved',
          'note': 'saved',
          'entryId': entry.id,
          'reviewerUid': 'u1',
          'reviewedAtMs': 999,
        }, 3),
      ]);
      await fixture.stage(replacement);
      await fixture.install(replacement);
      expect((await replacement.listEntries()).single.toJson(), entry.toJson());
      expect(
        (await replacement.listSubmissions()).single['state'],
        'review_pending',
      );
      expect(
        (await replacement.listOutbox()).single.toOperation(),
        before.toOperation(),
      );
      expect((await replacement.listOutbox()).single.attempts, before.attempts);
      await replacement.acknowledge(
        'saved_review',
        serverEntry: entry.toJson(),
      );
      expect(await replacement.listOutbox(), isEmpty);
      expect((await replacement.listEntries()).length, 1);
      expect((await replacement.listSubmissions()).single['state'], 'approved');
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test('snapshot proves restored dependency acceptance only when its stable ID has no pending queue', () async {
    final dir = await Directory.systemTemp.createTemp('accepted-recovery-');
    Future<LedgerStore> open(String name) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    try {
      await source.saveParty(reference.merchant);
      await source.acknowledge('m1');
      final sale = reference.invoice();
      await source.saveEntry(sale);
      await source.acknowledge(sale.id);
      final returned = reference.returned(sale, 'pending_return', 1000, [sale]);
      await source.saveEntry(returned);
      await source.fail(returned.id, 'unavailable', nowMs: 100);
      await replacement.restoreBackup(await source.exportPendingBackup());
      expect(await replacement.entryState(sale.id), 'pending');
      final fixture = Fixture([
        record('party', reference.merchant.toJson(), 1),
        record('entry', sale.toJson(), 2),
        record('entry', returned.toJson(), 3),
      ]);
      await fixture.stage(replacement);
      await fixture.install(replacement);
      expect(await replacement.entryState(sale.id), 'server_accepted');
      expect(await replacement.entryState(returned.id), 'retry');
      expect((await replacement.listOutbox()).single.id, returned.id);
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test('pending recovery refuses queue overflow without truncating or mutating the source', () async {
    final dir = await Directory.systemTemp.createTemp('bounded-recovery-');
    final path = '${dir.path}/ledger.db';
    final store = await LedgerStore.open(
      path: path,
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    try {
      final db = await databaseFactoryFfi.openDatabase(
        path,
        options: OpenDatabaseOptions(singleInstance: false),
      );
      final batch = db.batch();
      for (var i = 0; i <= LedgerStore.pendingBackupMaxItems; i++) {
        final id = 'pending_$i';
        batch.insert('outbox', {
          'id': id,
          'entity': 'party',
          'payload': jsonEncode({...reference.merchant.toJson(), 'id': id}),
          'created_ms': i,
        });
      }
      await batch.commit(noResult: true);
      await db.close();
      await expectLater(
        store.exportPendingBackup(),
        throwsA(
          isA<LedgerException>().having(
            (e) => e.code,
            'code',
            'backup_queue_limit',
          ),
        ),
      );
      expect(
        (await store.listOutbox()).length,
        LedgerStore.pendingBackupMaxItems + 1,
      );
      expect(await store.preference('cursor'), isNull);
    } finally {
      await store.close();
      await dir.delete(recursive: true);
    }
  });
  test('prospective salary correction preserves reason outside immutable financial payload through portable recovery', () async {
    final dir = await Directory.systemTemp.createTemp('salary-recovery-');
    Future<LedgerStore> open(String name) => LedgerStore.open(
      path: '${dir.path}/$name.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final source = await open('source'),
        replacement = await open('replacement');
    const original = SalaryTerm(
      id: 'closed_salary',
      tenantId: 't1',
      employeeId: 'e1',
      effectiveMonth: '2026-08',
      monthlyMinor: 123456,
    );
    try {
      await source.saveEmployee(reference.employee);
      await source.acknowledge(reference.employee.id);
      await source.saveSalaryTerm(original);
      await source.fail(original.id, 'closed-period');
      final correctedId = await source.saveClosedPeriodCorrection(
        original.id,
        date: '2026-11-02',
        note: '  prospective salary evidence reviewed  ',
      );
      final corrected = (await source.listOutbox()).singleWhere(
        (o) => o.id == correctedId,
      );
      final operation = corrected.toOperation();
      expect(
        operation['correctionReason'],
        'prospective salary evidence reviewed',
      );
      expect(operation['correctionOfOperationId'], original.id);
      expect(
        (operation['payload'] as Map).containsKey('correctionReason'),
        isFalse,
      );
      expect(
        corrected.payload['correctionReason'],
        operation['correctionReason'],
      );
      expect(
        (await source.listSalaryTerms())
            .singleWhere((t) => t.id == original.id)
            .toJson(),
        original.toJson(),
      );
      final backup = await source.exportPendingBackup();
      await replacement.restoreBackup(
        await RecoveryBackup.decrypt(
          await RecoveryBackup.encrypt(backup, password),
          password,
        ),
      );
      expect(
        (await replacement.listOutbox())
            .singleWhere((o) => o.id == correctedId)
            .toOperation(),
        operation,
      );
      expect(
        (await replacement.listSalaryTerms())
            .singleWhere((t) => t.id == correctedId)
            .effectiveMonth,
        '2026-11',
      );
      final bad = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(backup)) as Map,
      );
      final row = (bad['outbox'] as List).singleWhere(
        (r) => r['id'] == correctedId,
      ) as Map;
      final payload = Map<String, dynamic>.from(
        jsonDecode(row['payload'] as String) as Map,
      )..remove('correctionReason');
      row['payload'] = jsonEncode(payload);
      await expectLater(
        replacement.restoreBackup(bad),
        throwsA(
          isA<LedgerException>().having(
            (e) => e.code,
            'code',
            'correction_reason',
          ),
        ),
      );
    } finally {
      await source.close();
      await replacement.close();
      await dir.delete(recursive: true);
    }
  });
  test(
    'wrong phrase, tampering and unbounded KDF parameters fail before restore',
    () async {
      final encrypted = await RecoveryBackup.encrypt({
        'tenantId': 't1',
        'records': ['sensitive'],
      }, password);
      expect(jsonEncode(encrypted), isNot(contains('sensitive')));
      await expectLater(
        RecoveryBackup.decrypt(encrypted, 'A different long phrase'),
        throwsA(isA<LedgerException>()),
      );
      final tag = base64Decode(encrypted['tag'] as String);
      tag[0] ^= 1;
      await expectLater(
        RecoveryBackup.decrypt({
          ...encrypted,
          'tag': base64Encode(tag),
        }, password),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        RecoveryBackup.decrypt({
          ...encrypted,
          'iterations': 999999999,
        }, password),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        RecoveryBackup.encrypt({}, 'short'),
        throwsA(isA<LedgerException>()),
      );
    },
  );
}
