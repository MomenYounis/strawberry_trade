import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/recovery_backup.dart';

import 'domain_test.dart' as reference;

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
      final backup = await source.exportPendingBackup();
      expect(backup['entries'], isEmpty);
      expect(backup['employees'], isEmpty);
      await replacement.restoreBackup(backup);
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
